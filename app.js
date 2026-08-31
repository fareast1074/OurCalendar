import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getDatabase, ref, get, set, update, remove, onValue, push } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const configured = !Object.values(firebaseConfig).some(v => String(v).includes("YOUR_"));
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const $ = id => document.getElementById(id);
const state = {
  user: null, profile: null, calendars: [], events: [], activeCalendarId: null,
  visibleDate: new Date(), unsubCalendars: null, unsubCalendarRoot: null, unsubEvents: null, unsubShareMembers: null, eventsLoaded: false,
  editingEventId: null, theme: localStorage.getItem("pastelTheme") || "maroon"
};

document.documentElement.dataset.theme = state.theme;

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}
function formatDateKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function parseLocalDateTime(date, time) { const [y,m,d] = date.split("-").map(Number); const [hh,mm] = time.split(":").map(Number); return new Date(y,m-1,d,hh,mm); }
function fmtMonth(d) { return d.toLocaleDateString(undefined,{month:"long",year:"numeric"}); }
function fmtTime(date) { return date.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}); }
function initials(name="User") { return name.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase() || "U"; }
function makeShareCode() { return Math.random().toString(36).slice(2,8).toUpperCase(); }
function escapeHtml(s="") { return s.replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c])); }
function calendarById(id) { return state.calendars.find(c => c.id === id); }
function setModal(id, show) { const el=$(id); el.classList.toggle("hidden", !show); el.setAttribute("aria-hidden", String(!show)); }
function canEditCalendar(cal) { return Boolean(cal && state.user); }
function isShared(cal) { return Number(cal?.memberCount || 0) > 1; }

function normalizeUsername(value="") {
  return value.trim().toLowerCase();
}
function validUsername(username) {
  return /^[a-z0-9](?:[a-z0-9._-]{1,18}[a-z0-9])?$/.test(username);
}
async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function validateCredentials(username, password) {
  const u=normalizeUsername(username);
  if(!validUsername(u)) return "Username must be 3–20 characters using letters, numbers, dot, dash or underscore.";
  if(password.length < 6) return "Password must be at least 6 characters.";
  return null;
}

async function registerAccount(username, password) {
  if (!configured) return toast("Add your Firebase config in firebase-config.js first.");
  const clean=normalizeUsername(username); const problem=validateCredentials(clean,password);
  if(problem) return toast(problem);
  try {
    const userRef = ref(db, `users/${clean}`);
    const existing = await get(userRef);
    if(existing.exists()) return toast("That username is already taken.");
    const passwordHash = await hashPassword(password);
    const now = Date.now();
    await set(userRef, {
      username: clean,
      displayName: clean,
      passwordHash,
      createdAt: now,
      calendarRefs: {}
    });
    state.user = { uid: clean, username: clean, displayName: clean };
    state.profile = { username: clean, displayName: clean };
    localStorage.setItem("pastelSession", JSON.stringify(state.user));
    showApp();
    toast("Account created.");
  } catch(err) { toast(err.message || "Could not create account."); }
}

async function loginAccount(username,password) {
  if (!configured) return toast("Add your Firebase config in firebase-config.js first.");
  const clean=normalizeUsername(username); const problem=validateCredentials(clean,password);
  if(problem) return toast(problem);
  try {
    const snap = await get(ref(db, `users/${clean}`));
    if(!snap.exists()) return toast("Username or password is incorrect.");
    const data = snap.val() || {};
    const passwordHash = await hashPassword(password);
    if(data.passwordHash !== passwordHash) return toast("Username or password is incorrect.");
    state.user = { uid: clean, username: clean, displayName: data.displayName || clean };
    state.profile = data;
    localStorage.setItem("pastelSession", JSON.stringify(state.user));
    showApp();
    toast("Welcome back.");
  } catch(err) { toast(err.message || "Could not sign in."); }
}

function logoutAccount() {
  localStorage.removeItem("pastelSession");
  state.user = null; state.profile = null; state.calendars=[]; state.events=[]; state.activeCalendarId=null;
  state.unsubCalendars?.(); state.unsubCalendarRoot?.(); state.unsubEvents?.(); state.unsubShareMembers?.();
  $("authView").classList.remove("hidden"); $("mainView").classList.add("hidden");
  setAuthMode("login");
}

function showApp() {
  $("authView").classList.add("hidden"); $("mainView").classList.remove("hidden");
  renderUser(); subscribeCalendars(); renderCalendar(); renderUpcoming();
}

let authMode="login";
function setAuthMode(mode){
  authMode=mode;
  document.querySelectorAll("[data-auth-mode]").forEach(btn=>btn.classList.toggle("active",btn.dataset.authMode===mode));
  $("authSubmit").textContent=mode==="login"?"Sign in":"Create account";
  $("authTitle").textContent=mode==="login"?"Welcome back.":"Create your account.";
  $("authSubtitle").textContent=mode==="login"?"Sign in with your username and password. No email needed.":"Create a simple username and password. No email address is required.";
}

$("authForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const username=$("authUsername").value; const password=$("authPassword").value;
  $("authSubmit").disabled=true;
  try {
    if(authMode==="login") await loginAccount(username,password);
    else await registerAccount(username,password);
  } finally { $("authSubmit").disabled=false; }
});
document.querySelectorAll("[data-auth-mode]").forEach(btn=>btn.addEventListener("click",()=>setAuthMode(btn.dataset.authMode)));

$("logoutBtn")?.addEventListener("click",logoutAccount);

async function ensureUserProfile(user) {
  const snap = await get(ref(db, `users/${user.uid}`));
  state.profile = snap.exists() ? snap.val() : { displayName: user.displayName || user.uid, username: user.uid };
}

function renderUser() {
  const name=state.profile?.displayName || state.user?.displayName || "User";
  $("greetingTitle").textContent=`Hi, ${name.split(" ")[0]}`; $("avatarInitial").textContent=initials(name);
}

function subscribeCalendars() {
  state.unsubCalendars?.();
  state.unsubCalendarRoot?.();
  state.unsubEvents?.();
  state.events = [];
  state.eventsLoaded = false;

  if (!state.user) return;

  let calendarIds = [];
  let allCalendars = {};

  const refreshCalendars = () => {
    state.calendars = calendarIds
      .map(id => {
        const raw = allCalendars[id];
        if (!raw) return null;
        const members = raw.members || {};
        return { id, ...raw, memberCount: Object.keys(members).length };
      })
      .filter(Boolean)
      .sort((a,b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

    const nextActive = state.calendars.some(c => c.id === state.activeCalendarId)
      ? state.activeCalendarId
      : (state.calendars[0]?.id || null);

    if (nextActive !== state.activeCalendarId) {
      state.activeCalendarId = nextActive;
      subscribeEvents();
    } else if (!state.activeCalendarId) {
      subscribeEvents();
    }

    renderCalendars();
    renderEventSelect();
    renderCalendar();
    renderUpcoming();
  };

  state.unsubCalendars = onValue(ref(db, `users/${state.user.uid}`), snap => {
    const data = snap.val() || {};
    state.profile = data;
    const refs = data.calendarRefs || {};
    calendarIds = Object.keys(refs).sort((a,b) => Number(refs[a]?.joinedAt || 0) - Number(refs[b]?.joinedAt || 0));
    refreshCalendars();
    renderUser();
  }, err => toast(`User data sync error: ${err.message || "check Realtime Database rules."}`));

  state.unsubCalendarRoot = onValue(ref(db, "calendars"), snap => {
    allCalendars = snap.val() || {};
    refreshCalendars();
  }, err => toast(`Calendar sync error: ${err.message || "check Realtime Database rules."}`));
}

function subscribeEvents() {
  state.unsubEvents?.();
  state.events = [];
  state.eventsLoaded = false;
  if (!state.activeCalendarId) { renderCalendar(); renderUpcoming(); return; }

  state.unsubEvents = onValue(ref(db, `calendars/${state.activeCalendarId}/events`), snap => {
    const raw = snap.val() || {};
    state.events = Object.entries(raw).map(([id, data]) => ({ id, ...data }));
    state.events.sort((a,b) => `${a.date}T${a.time || "00:00"}`.localeCompare(`${b.date}T${b.time || "00:00"}`));
    state.eventsLoaded = true;
    renderCalendar();
    renderUpcoming();
  }, err => toast(`Event sync error: ${err.message || "check Realtime Database rules."}`));
}

function renderCalendars() {
  const wrap=$("calendarList"); wrap.innerHTML="";
  state.calendars.forEach(cal=>{
    const row=document.createElement("div"); row.className=`calendar-item ${cal.id===state.activeCalendarId?"active":""}`;
    row.innerHTML=`<span class="calendar-swatch"></span><div class="calendar-meta"><strong>${escapeHtml(cal.name||"Calendar")}</strong><span>${Number(cal.memberCount||0)} member${Number(cal.memberCount||0)===1?"":"s"} · ${cal.shareCode||""}</span></div><button class="share-small" aria-label="Share calendar">↗</button>`;
    row.addEventListener("click",e=>{ if(e.target.closest(".share-small")) return; state.activeCalendarId=cal.id; subscribeEvents(); renderCalendars(); renderEventSelect(); renderCalendar(); renderUpcoming(); });
    row.querySelector(".share-small").addEventListener("click",e=>{e.stopPropagation();openShare(cal.id)}); wrap.appendChild(row);
  });
  if(!state.calendars.length) wrap.innerHTML=`<p class="muted" style="font-size:12px;margin:0">No calendars yet. Create one to start.</p>`;
}

function renderEventSelect() {
  const select=$("eventCalendar"); select.innerHTML=state.calendars.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  if(state.activeCalendarId) select.value=state.activeCalendarId;
}

function eventsForDate(dateKey) { return state.events.filter(e => e.date===dateKey); }

function renderCalendar() {
  const d=state.visibleDate; $("monthTitle").textContent=fmtMonth(d); const grid=$("calendarGrid"); grid.innerHTML="";
  const first=new Date(d.getFullYear(),d.getMonth(),1); const start=new Date(first); start.setDate(first.getDate()-first.getDay());
  const todayKey=formatDateKey(new Date());
  for(let i=0;i<42;i++){
    const cellDate=new Date(start); cellDate.setDate(start.getDate()+i); const key=formatDateKey(cellDate); const outside=cellDate.getMonth()!==d.getMonth();
    const cell=document.createElement("button"); cell.className=`day-cell ${outside?"other":""} ${key===todayKey?"today":""}`; cell.dataset.date=key;
    const items=eventsForDate(key).slice(0,3);
    cell.innerHTML=`<span class="day-number">${cellDate.getDate()}</span><div class="day-events">${items.map(ev=>`<span class="event-pill ${isShared(calendarById(ev.calendarId))?"shared":""}">${escapeHtml(ev.title||"Event")}</span>`).join("")}</div>`;
    cell.addEventListener("click",()=>openEventModal(null,key)); grid.appendChild(cell);
  }
}

function renderUpcoming() {
  const wrap=$("upcomingList"); const now=new Date(); const visible=state.events.filter(e=>{const cal=calendarById(e.calendarId); return cal && new Date(`${e.date}T${e.time||"00:00"}`)>=now;}).sort((a,b)=>`${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`)).slice(0,8);
  if(!visible.length){wrap.innerHTML=`<p class="muted" style="font-size:12px;margin:0">No upcoming events in this calendar.</p>`; return;}
  wrap.innerHTML=visible.map(ev=>{const dt=new Date(`${ev.date}T${ev.time||"00:00"}`); return `<button class="upcoming-item" data-id="${ev.id}"><div class="date-chip"><b>${dt.getDate()}</b><small>${dt.toLocaleDateString(undefined,{month:"short"})}</small></div><div class="upcoming-copy"><strong>${escapeHtml(ev.title)}</strong><span>${escapeHtml(calendarById(ev.calendarId)?.name||"")} · ${escapeHtml(ev.location||"No location")}</span></div><span class="upcoming-time">${fmtTime(dt)}</span></button>`;}).join("");
  wrap.querySelectorAll(".upcoming-item").forEach(btn=>btn.addEventListener("click",()=>openEventModal(btn.dataset.id)));
}

function openEventModal(id=null,dateKey=null) {
  state.editingEventId=id; renderEventSelect(); $("eventId").value=id||"";
  if(id){
    const ev=state.events.find(x=>x.id===id); if(!ev) return;
    $("eventModalEyebrow").textContent="EDIT EVENT"; $("eventModalTitle").textContent="Update event"; $("eventTitle").value=ev.title||""; $("eventDate").value=ev.date; $("eventTime").value=ev.time||"09:00"; $("eventCalendar").value=ev.calendarId; $("eventLocation").value=ev.location||""; $("eventNotes").value=ev.notes||""; $("deleteEventBtn").classList.toggle("hidden", ev.createdBy!==state.user.uid);
  } else {
    $("eventModalEyebrow").textContent="NEW EVENT"; $("eventModalTitle").textContent="Add event"; $("eventTitle").value=""; $("eventDate").value=dateKey||formatDateKey(new Date()); $("eventTime").value="09:00"; $("eventCalendar").value=state.activeCalendarId||state.calendars[0]?.id||""; $("eventLocation").value=""; $("eventNotes").value=""; $("deleteEventBtn").classList.add("hidden");
  }
  setModal("eventModal",true); setTimeout(()=>$("eventTitle").focus(),50);
}

$("eventForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const title=$("eventTitle").value.trim(), date=$("eventDate").value, time=$("eventTime").value, calendarId=$("eventCalendar").value;
  if(!title||!date||!time||!calendarId) return toast("Please complete the event details.");

  try{
    if(state.editingEventId){
      const previous=state.events.find(ev=>ev.id===state.editingEventId);
      if(!previous) return toast("Event could not be found.");

      const updatedPayload={
        title,
        date,
        time,
        calendarId,
        location:$("eventLocation").value.trim(),
        notes:$("eventNotes").value.trim(),
        createdBy:previous.createdBy || state.user.uid,
        createdAt:previous.createdAt || Date.now(),
        updatedAt:Date.now()
      };

      if(previous.calendarId===calendarId){
        await update(ref(db, `calendars/${calendarId}/events/${state.editingEventId}`), updatedPayload);
      } else {
        const updates={};
        updates[`calendars/${calendarId}/events/${state.editingEventId}`]=updatedPayload;
        updates[`calendars/${previous.calendarId}/events/${state.editingEventId}`]=null;
        await update(ref(db), updates);
      }
      toast("Event updated and synced.");
    } else {
      const eventRef=push(ref(db, `calendars/${calendarId}/events`));
      await set(eventRef, {
        title,
        date,
        time,
        calendarId,
        location:$("eventLocation").value.trim(),
        notes:$("eventNotes").value.trim(),
        createdBy:state.user.uid,
        createdAt:Date.now(),
        updatedAt:Date.now()
      });
      toast("Event added and synced.");
    }
    setModal("eventModal",false);
  }catch(err){ toast(err.message||"Could not save event."); }
});

$("deleteEventBtn").addEventListener("click",async()=>{
  const ev=state.events.find(x=>x.id===state.editingEventId); if(!ev) return;
  if(ev.createdBy!==state.user.uid) return toast("Only the event creator can delete it.");
  try {
    await remove(ref(db, `calendars/${ev.calendarId}/events/${ev.id}`));
    setModal("eventModal",false);
    toast("Event deleted.");
  } catch(err){toast(err.message||"Could not delete event.");}
});

$("addCalendarBtn").addEventListener("click",()=>{ $("calendarName").value=""; setModal("calendarModal",true); setTimeout(()=>$("calendarName").focus(),50); });
$("calendarForm").addEventListener("submit",async e=>{
  e.preventDefault(); if(!state.user) return;
  const name=$("calendarName").value.trim(); if(!name) return;
  const shareCode=makeShareCode();
  const newCalendarRef=push(ref(db,"calendars"));
  const id=newCalendarRef.key;
  const now=Date.now();

  try {
    const ownerName=state.profile?.displayName||state.user.displayName||"Owner";
    const ownerUsername=state.profile?.username||state.user.username||state.user.uid;
    const updates={};
    updates[`calendars/${id}`]={
      name,
      theme:$("calendarColor").value,
      shareCode,
      createdBy:state.user.uid,
      createdAt:now,
      members:{
        [state.user.uid]:{role:"owner",name:ownerName,username:ownerUsername,joinCode:shareCode,joinedAt:now}
      },
      events:{}
    };
    updates[`users/${state.user.uid}/calendarRefs/${id}`]={calendarId:id,joinedAt:now};
    updates[`joinCodes/${shareCode}`]={calendarId:id,createdBy:state.user.uid,createdAt:now};
    await update(ref(db),updates);
    state.activeCalendarId=id;
    setModal("calendarModal",false);
    toast("Calendar created.");
    setTimeout(()=>openShare(id),350);
  } catch(err){toast(err.message||"Could not create calendar.");}
});

$("joinBtn").addEventListener("click", async () => {
  const code = $("joinCodeInput").value.trim().toUpperCase();
  if (!code) return toast("Enter a share code.");
  try {
    const codeSnap = await get(ref(db, `joinCodes/${code}`));
    if (!codeSnap.exists()) return toast("Share code not found.");
    const codeData = codeSnap.val() || {};
    const calendarId = codeData.calendarId;
    const calendarSnap = await get(ref(db, `calendars/${calendarId}`));
    if (!calendarSnap.exists()) return toast("That shared calendar no longer exists.");

    const now=Date.now();
    const member={
      role:"member",
      name:state.profile?.displayName || state.user.displayName || "Member",
      username:state.profile?.username || state.user.username || state.user.uid,
      joinCode:code,
      joinedAt:now
    };
    const updates={};
    updates[`calendars/${calendarId}/members/${state.user.uid}`]=member;
    updates[`users/${state.user.uid}/calendarRefs/${calendarId}`]={calendarId,joinedAt:now};
    await update(ref(db),updates);
    $("joinCodeInput").value="";
    state.activeCalendarId=calendarId;
    subscribeEvents();
    toast("Joined shared calendar.");
  } catch (err) { toast(err.message || "Could not join calendar."); }
});

async function openShare(id){
  const cal=calendarById(id); if(!cal) return;
  $("shareTitle").textContent=cal.name||"Calendar access";
  $("shareCodeValue").textContent=cal.shareCode||"------";
  await renderMembers(cal);
  setModal("shareModal",true);
  state.unsubShareMembers?.();
  state.unsubShareMembers=onValue(ref(db, `calendars/${id}/members`),snap=>{
    const membersRaw=snap.val() || {};
    renderMembers({...cal,memberDocs:Object.values(membersRaw),memberCount:Object.keys(membersRaw).length});
  },()=>{});
}

async function renderMembers(cal){
  let members=cal.memberDocs;
  if(!members){
    try {
      const snap=await get(ref(db, `calendars/${cal.id}/members`));
      const raw=snap.val() || {};
      members=Object.values(raw);
    } catch { members=[]; }
  }
  const wrap=$("memberList");
  wrap.innerHTML=members.map(m=>`<div class="member-row"><div class="member-badge">${initials(m.name||m.username)}</div><div><strong>${escapeHtml(m.name||m.username||"Member")}</strong><small>@${escapeHtml(m.username||"user")} · ${escapeHtml(m.role||"member")}</small></div></div>`).join("");
}

$("copyCodeBtn").addEventListener("click",async()=>{try{await navigator.clipboard.writeText($("shareCodeValue").textContent);toast("Share code copied.");}catch{toast("Share code: "+$("shareCodeValue").textContent);}});

$("prevMonth").addEventListener("click",()=>{state.visibleDate=new Date(state.visibleDate.getFullYear(),state.visibleDate.getMonth()-1,1);renderCalendar();});
$("nextMonth").addEventListener("click",()=>{state.visibleDate=new Date(state.visibleDate.getFullYear(),state.visibleDate.getMonth()+1,1);renderCalendar();});
function goToday(){state.visibleDate=new Date();renderCalendar();}
$("todayBtn").addEventListener("click",goToday); $("navToday").addEventListener("click",goToday);
$("fab").addEventListener("click",()=>openEventModal()); $("addEventTopBtn").addEventListener("click",()=>openEventModal());
$("navShare").addEventListener("click",()=> state.activeCalendarId ? openShare(state.activeCalendarId) : toast("Create or join a calendar first."));
$("themeBtn").addEventListener("click",()=>$("themePopover").classList.toggle("hidden"));
document.querySelectorAll("[data-theme]").forEach(btn=>btn.addEventListener("click",()=>{state.theme=btn.dataset.theme;document.documentElement.dataset.theme=state.theme;localStorage.setItem("pastelTheme",state.theme);$("themePopover").classList.add("hidden");}));
document.addEventListener("click",e=>{if(!e.target.closest("#themeBtn")&&!e.target.closest("#themePopover"))$("themePopover").classList.add("hidden");});
document.querySelectorAll("[data-close]").forEach(btn=>btn.addEventListener("click",()=>setModal(btn.dataset.close+"Modal",false)));

const savedSession = localStorage.getItem("pastelSession");
if (savedSession) {
  try {
    state.user = JSON.parse(savedSession);
    if (state.user?.uid) {
      showApp();
    } else {
      localStorage.removeItem("pastelSession");
    }
  } catch {
    localStorage.removeItem("pastelSession");
  }
}

if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("service-worker.js").catch(()=>{}));
if(!configured) setTimeout(()=>toast("Firebase setup required: edit firebase-config.js."),700);
