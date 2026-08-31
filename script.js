let fetchedHolidays = {};
let countdownInterval = null;

async function fetchMalaysianHolidays() {
    const year = new Date().getFullYear();
    try {
        const response = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/MY`);
        const data = await response.json();
        data.forEach(h => {
            fetchedHolidays[h.date] = h.name;
        });
        renderCalendar(); 
    } catch (err) {
        console.error("Could not fetch holidays", err);
    }
}

const firebaseConfig = {
    apiKey: "AIzaSyD7fcmeJe6C-XWLBMq213panWHZekLA_mo",
    authDomain: "trip-planner-edb3f.firebaseapp.com",
    databaseURL: "https://trip-planner-edb3f-default-rtdb.firebaseio.com",
    projectId: "trip-planner-edb3f",
    storageBucket: "trip-planner-edb3f.firebasestorage.app",
    messagingSenderId: "829260334284",
    appId: "1:829260334284:web:58c69022a11fc0974ad01b"
};

let database = null;
try {
    firebase.initializeApp(firebaseConfig);
    database = firebase.database();
} catch(e) {
    console.error("Firebase startup structural protocol halted.", e);
}

let currentUser = localStorage.getItem('ourcalendarSharedCloudUser') || localStorage.getItem('ourcalendarSharedCloudUser') || null;
let currentDate = new Date();
let selectedDate = new Date();
let calendarEvents = {}; 
let baselineDataTrackingObject = null; 
let currentFilterScope = 'all'; 
let filteredTargetUser = ''; 
let systemMutedOnInit = true;   
let activeEditingNode = { eventId: null };
let currentCalendarView = localStorage.getItem('ourcalendarCalendarView') || localStorage.getItem('ourcalendarCalendarView') || 'month';
if(currentCalendarView==='week') currentCalendarView='month';
let browserNotificationsEnabled = localStorage.getItem('ourcalendarBrowserNotifications') === 'true' || localStorage.getItem('ourcalendarBrowserNotifications') === 'true'; 

if(localStorage.getItem('ourcalendarDarkThemeActive') === 'true' || localStorage.getItem('ourcalendarDarkThemeActive') === 'true') {
    document.body.classList.add('dark-mode');
}

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthsKey = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const fullMonthsKey = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const malayMonthsKey = ["januari", "februari", "mac", "april", "mei", "jun", "julai", "ogos", "september", "oktober", "november", "disember"];

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>'"]/g, function(ch) {
        return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[ch];
    });
}

function getParticipantsArray(item) {
    return item && item.participant ? item.participant.split(',').map(p => p.trim()).filter(Boolean) : [];
}

function buildInviteStatus(participants, previousStatus = {}) {
    const status = { ...(previousStatus || {}) };
    participants.forEach(name => { if (!status[name]) status[name] = 'pending'; });
    if (currentUser) status[currentUser] = 'accepted';
    Object.keys(status).forEach(name => {
        if (name !== currentUser && !participants.includes(name)) delete status[name];
    });
    return status;
}

function buildInviteStatusHTML(item, eventId) {
    const participants = getParticipantsArray(item);
    const inviteStatus = item.inviteStatus || {};
    if (participants.length === 0) return '';
    const statusIcons = { accepted: '✅', declined: '❌', pending: '⏳' };
    const chips = participants.map(name => {
        const status = inviteStatus[name] || 'pending';
        return `<span class="invite-status-chip status-${escapeHTML(status)}">${statusIcons[status] || '⏳'} @${escapeHTML(name)} ${escapeHTML(status)}</span>`;
    }).join(' ');
    const myStatus = inviteStatus[currentUser] || 'pending';
    const actionButtons = participants.includes(currentUser) && item.owner !== currentUser && myStatus === 'pending'
        ? `<span class="invite-action-cluster"><button onclick="respondToInvitation('${escapeHTML(eventId)}','accepted')">Accept</button><button onclick="respondToInvitation('${escapeHTML(eventId)}','declined')">Decline</button></span>`
        : '';
    return `<div class="invite-status-row">${chips} ${actionButtons}</div>`;
}

function triggerBrowserNotification(title, body) {
    if (!browserNotificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    new Notification(title, { body, icon: 'OurCalendar.jpg', badge: 'OurCalendar.jpg' });
}

async function enableBrowserNotifications() {
    if (!('Notification' in window)) {
        triggerToastAlert('Browser notifications are not supported here.');
        return;
    }
    const permission = await Notification.requestPermission();
    browserNotificationsEnabled = permission === 'granted';
    localStorage.setItem('ourcalendarBrowserNotifications', browserNotificationsEnabled);
    triggerToastAlert(browserNotificationsEnabled ? 'Browser notifications enabled.' : 'Notification permission was not granted.');
}

function setCalendarView(view) {
    currentCalendarView = view;
    localStorage.setItem('ourcalendarCalendarView', view);
    document.querySelectorAll('.view-pill').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
    renderCalendar();
}

function buildExtendedMetaHTML(item) {
    const chunks = [];
    if (item.priority) chunks.push(`<span class="meta-chip priority-${escapeHTML(item.priority)}">⚡ ${escapeHTML(item.priority)}</span>`);
    if (item.location) chunks.push(`<span class="meta-chip">📍 ${escapeHTML(item.location)}</span>`);
    if (item.notes) chunks.push(`<span class="meta-chip notes-chip" title="${escapeHTML(item.notes)}">📝 Notes</span>`);
    if (item.createdAt) chunks.push(`<span class="meta-chip">🧾 ${new Date(item.createdAt).toLocaleDateString()}</span>`);
    return chunks.length ? `<div class="event-meta-row">${chunks.join('')}</div>` : '';
}

function eventMatchesDate(item, dateString) {
    return item && item.startDate <= dateString && item.endDate >= dateString;
}

function passesScopeFilter(item) {
    const participants = getParticipantsArray(item);
    if (currentFilterScope === 'all') return true;
    if (currentFilterScope === 'me') return item.owner === currentUser || participants.includes(currentUser);
    if (currentFilterScope === 'specific') return item.owner === filteredTargetUser || participants.includes(filteredTargetUser);
    return true;
}

window.onload = function() {
    fetchMalaysianHolidays(); 
    if ('serviceWorker' in navigator) { navigator.serviceWorker.register('service-worker.js').catch(console.error); }
    if (currentUser) { 
        bootApplicationView(); 
    }
};

function executeThemeToggle() {
    const isDarkNow = document.body.classList.toggle('dark-mode');
    localStorage.setItem('ourcalendarDarkThemeActive', isDarkNow);
}

async function executeSignUp() {
    const usernameInput = document.getElementById('loginUsername').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    const passwordInput = document.getElementById('loginPassword').value.trim();

    if (!usernameInput || !passwordInput) { 
        alert('Both username and password are required to sign up!'); 
        return; 
    }

    if(database) {
        const userRef = database.ref(`users/${usernameInput}`);
        const snapshot = await userRef.once('value');

        if (snapshot.exists()) {
            alert('Profile already exists! Please click Sign In instead.');
        } else {
            await userRef.set({ password: passwordInput });
            alert('Profile successfully created! You can now Sign In.');
        }
    } else {
        alert('Database connection unavailable.');
    }
}

async function executeProfileLogin() {
    const usernameInput = document.getElementById('loginUsername').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    const passwordInput = document.getElementById('loginPassword').value.trim();

    if (!usernameInput || !passwordInput) { 
        alert('Both username and password are required!'); 
        return; 
    }

    if(database) {
        const userRef = database.ref(`users/${usernameInput}`);
        const snapshot = await userRef.once('value');

        if (!snapshot.exists()) {
            alert('Profile not found. Please click Sign Up to create an account first.');
            return;
        }

        const userData = snapshot.val();
        if (userData.password !== passwordInput) {
            alert('Incorrect password!');
            return;
        }

        currentUser = usernameInput;
        localStorage.setItem('ourcalendarSharedCloudUser', currentUser);
        document.getElementById('loginPassword').value = '';
        bootApplicationView();
    } else {
        alert('Database connection unavailable.');
    }
}

function bootApplicationView() {
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    document.getElementById('display-profile-tag').innerText = `@${currentUser}`;
    
    const todayStr = formatDateString(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
    document.getElementById('newEventStartDate').value = todayStr;
    document.getElementById('newEventEndDate').value = todayStr;

    const adminPanel = document.getElementById('developerAdminPanel');
    if(currentUser === 'faiz') {
        adminPanel.classList.remove('hidden');
        loadAdminUserList();
    } else {
        adminPanel.classList.add('hidden');
    }

    loadParticipantCheckboxes();
    establishLiveFirebaseListener();
}

function loadParticipantCheckboxes() {
    if(database) {
        database.ref('users').on('value', snapshot => {
            const users = snapshot.val() || {};
            const container = document.getElementById('participantCheckboxes');
            container.innerHTML = '';
            
            Object.keys(users).forEach(u => {
                if(u !== currentUser) {
                    const label = document.createElement('label');
                    label.className = 'checkbox-label';
                    label.innerHTML = `
                        <input type="checkbox" class="ourcalendar-checkbox" value="${u}" onchange="updateParticipantField(); toggleCheckboxStyle(this);">
                        <span class="custom-checkmark"></span>
                        @${u}
                    `;
                    container.appendChild(label);
                }
            });
            
            if(container.innerHTML === '') {
                container.innerHTML = '<span style="font-size:0.75rem; color:var(--text-muted);">No other users found in system.</span>';
            }
        });
    }
}

function toggleCheckboxStyle(checkbox) {
    if(checkbox.checked) {
        checkbox.parentElement.classList.add('is-active');
    } else {
        checkbox.parentElement.classList.remove('is-active');
    }
}

function toggleSelectAll(selectAllCheckbox) {
    const checkboxes = document.querySelectorAll('#participantCheckboxes .ourcalendar-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = selectAllCheckbox.checked;
        toggleCheckboxStyle(cb);
    });
    
    if(selectAllCheckbox.checked) {
        selectAllCheckbox.parentElement.classList.add('is-active');
    } else {
        selectAllCheckbox.parentElement.classList.remove('is-active');
    }
    
    updateParticipantField();
}

function updateParticipantField() {
    const checkboxes = document.querySelectorAll('#participantCheckboxes .ourcalendar-checkbox:checked');
    const selectedUsers = Array.from(checkboxes).map(cb => cb.value);
    document.getElementById('newEventParticipant').value = selectedUsers.join(', ');
    
    const allCheckboxes = document.querySelectorAll('#participantCheckboxes .ourcalendar-checkbox');
    const selectAll = document.getElementById('selectAllOurCalendars');
    
    if(selectAll && allCheckboxes.length > 0) {
        selectAll.checked = (checkboxes.length === allCheckboxes.length);
        if(selectAll.checked) {
            selectAll.parentElement.classList.add('is-active');
        } else {
            selectAll.parentElement.classList.remove('is-active');
        }
    }
}

function loadAdminUserList() {
    if(database) {
        database.ref('users').on('value', snapshot => {
            const users = snapshot.val() || {};
            const list = document.getElementById('adminUserList');
            list.innerHTML = '';
            
            Object.keys(users).forEach(u => {
                if(u !== 'faiz') {
                    const li = document.createElement('li');
                    li.className = 'admin-list-item';
                    li.innerHTML = `
                        <span>@${u}</span>
                        <button class="admin-btn-delete" onclick="deleteUserProfile('${u}')">Delete</button>
                    `;
                    list.appendChild(li);
                }
            });
            
            if(list.innerHTML === '') {
                list.innerHTML = '<li style="font-size: 0.8rem; color: var(--text-muted);">No other users found.</li>';
            }
        });
    }
}

function deleteUserProfile(targetUsername) {
    if(confirm(`WARNING: Are you absolutely sure you want to delete profile @${targetUsername}?`)) {
        if(database) {
            database.ref(`users/${targetUsername}`).remove().then(() => {
                alert(`Profile @${targetUsername} has been permanently deleted.`);
            });
        }
    }
}

function executeProfileLogout() {
    localStorage.removeItem('ourcalendarSharedCloudUser');
    currentUser = null;
    if(database) {
        database.ref('shared_events_v3').off();
        database.ref('users').off();
    }
    if(countdownInterval) clearInterval(countdownInterval);
    document.getElementById('app-container').classList.add('hidden');
    document.getElementById('login-container').classList.remove('hidden');
}

function triggerToastAlert(message) {
    const toast = document.getElementById('networkToast');
    toast.textContent = `⚡ ${message}`;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3500);
}

function establishLiveFirebaseListener() {
    if (database) {
        database.ref('shared_events_v3').on('value', (snapshot) => {
            const freshSnapshotData = snapshot.val() || {};
            
            if (baselineDataTrackingObject !== null && !systemMutedOnInit) {
                Object.keys(freshSnapshotData).forEach(keyId => {
                    if (!baselineDataTrackingObject.hasOwnProperty(keyId)) {
                        const freshlyAddedObject = freshSnapshotData[keyId];
                        if (freshlyAddedObject.owner !== currentUser) {
                            const participants = freshlyAddedObject.participant ? freshlyAddedObject.participant.split(',').map(p => p.trim()) : [];
                            if (participants.includes(currentUser)) {
                                triggerToastAlert(`🔔 @${freshlyAddedObject.owner} mentioned you in a plan: ${freshlyAddedObject.title}`);
                                triggerBrowserNotification('OurCalendar mention', `@${freshlyAddedObject.owner}: ${freshlyAddedObject.title}`);
                            } else {
                                triggerToastAlert(`📅 New Event Added by @${freshlyAddedObject.owner}: ${freshlyAddedObject.title}`);
                                triggerBrowserNotification('New OurCalendar plan', `@${freshlyAddedObject.owner}: ${freshlyAddedObject.title}`);
                            }
                        }
                    }
                });
            }
            
            baselineDataTrackingObject = { ...freshSnapshotData };
            calendarEvents = freshSnapshotData;
            systemMutedOnInit = false;

            populateUserFilterDropdown();
            calculateMonthlyMetrics();
            renderCalendar();
            updateAgendaView();
            renderIncomingEventsPipeline();
            calculateActiveTodayAlertsBanner();
            updateNextAdventureCountdown();
        });
    }
}

function applyQuickPreset(title, category, time) {
    document.getElementById('newEventInput').value = title;
    document.getElementById('newEventCategory').value = category;
    document.getElementById('newEventTime').value = time;
    triggerToastAlert(`Preset Loaded: "${title}"`);
}

function updateNextAdventureCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    
    const now = new Date();
    let closestEvent = null;
    let minDiff = Infinity;
    
    Object.values(calendarEvents).forEach(ev => {
        const participants = ev.participant ? ev.participant.split(',').map(p => p.trim()) : [];
        if (ev.owner === currentUser || participants.includes(currentUser)) {
            const timeStr = ev.time || "00:00";
            const [hours, minutes] = timeStr.split(':');
            const eventDateTime = new Date(ev.startDate);
            eventDateTime.setHours(parseInt(hours || 0), parseInt(minutes || 0), 0, 0);
            
            const diff = eventDateTime - now;
            if (diff > 0 && diff < minDiff) {
                minDiff = diff;
                closestEvent = { ...ev, targetTime: eventDateTime };
            }
        }
    });
    
    const widget = document.getElementById('nextEventCountdownWidget');
    if (!closestEvent) {
        widget.style.display = 'none';
        return;
    }
    
    widget.style.display = 'block';
    document.getElementById('countdown-title').innerText = `"${closestEvent.title}"`;
    
    function runCountdown() {
        const currentNow = new Date();
        const remainder = closestEvent.targetTime - currentNow;
        
        if (remainder <= 0) {
            document.getElementById('countdown-timer-display').innerText = "Adventure Active! 🚀";
            clearInterval(countdownInterval);
            return;
        }
        
        const days = Math.floor(remainder / (1000 * 60 * 60 * 24));
        const hours = Math.floor((remainder % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((remainder % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((remainder % (1000 * 60)) / 1000);
        
        document.getElementById('countdown-timer-display').innerText = 
            `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
    }
    
    runCountdown();
    countdownInterval = setInterval(runCountdown, 1000);
}

function populateUserFilterDropdown() {
    const selectEl = document.getElementById('filterUserSelect');
    if (!selectEl) return;
    const currentSelection = selectEl.value;
    
    const owners = new Set();
    Object.values(calendarEvents).forEach(ev => {
        if (ev.owner) owners.add(ev.owner);
        if (ev.participant) {
            ev.participant.split(',').forEach(p => {
                if(p.trim()) owners.add(p.trim());
            });
        }
    });
    
    selectEl.innerHTML = '<option value="">-- Select a OurCalendar --</option>';
    Array.from(owners).sort().forEach(owner => {
        const opt = document.createElement('option');
        opt.value = owner;
        opt.innerText = `@${owner}`;
        if (owner === currentSelection) opt.selected = true;
        selectEl.appendChild(opt);
    });
}

function handleUserFilterChange() {
    filteredTargetUser = document.getElementById('filterUserSelect').value;
    renderCalendar();
    updateAgendaView();
}

function calculateActiveTodayAlertsBanner() {
    const banner = document.getElementById('todayAlertBanner');
    const clock = new Date();
    const compactTodayStr = formatDateString(clock.getFullYear(), clock.getMonth(), clock.getDate());
    
    let matchingTodayObjects = [];
    Object.values(calendarEvents).forEach(ev => {
        const participants = ev.participant ? ev.participant.split(',').map(p => p.trim()) : [];
        const isAssociated = (ev.owner === currentUser || participants.includes(currentUser));
        if (isAssociated && compactTodayStr >= ev.startDate && compactTodayStr <= ev.endDate) {
            matchingTodayObjects.push(ev.title);
        }
    });

    if (matchingTodayObjects.length > 0) {
        banner.style.display = "block";
        banner.innerHTML = `🎯 <b>Active Today:</b> ${matchingTodayObjects.join(', ')}`;
    } else {
        banner.style.display = "none";
    }
}

function toggleCollapseSection(headerId, targetContentId) {
    document.getElementById(headerId).classList.toggle('collapsed');
    document.getElementById(targetContentId).classList.toggle('collapsed');
}

function setScopeFilter(scope) {
    currentFilterScope = scope;
    document.getElementById('filter-all-btn').classList.toggle('active', scope === 'all');
    document.getElementById('filter-me-btn').classList.toggle('active', scope === 'me');
    document.getElementById('filter-user-btn').classList.toggle('active', scope === 'specific');
    
    const userWrapper = document.getElementById('user-filter-wrapper');
    if (scope === 'specific') {
        userWrapper.classList.remove('hidden');
        filteredTargetUser = document.getElementById('filterUserSelect').value;
    } else {
        userWrapper.classList.add('hidden');
        filteredTargetUser = '';
    }
    
    renderCalendar();
    updateAgendaView();
}

function calculateMonthlyMetrics() {
    let individualMonthCounter = 0;
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth(); 
    
    const firstOfIdx = new Date(currentYear, currentMonth, 1);
    const lastOfIdx = new Date(currentYear, currentMonth + 1, 0);

    Object.values(calendarEvents).forEach(ev => {
        const participants = ev.participant ? ev.participant.split(',').map(p => p.trim()) : [];
        if (ev.owner === currentUser || participants.includes(currentUser)) {
            const sNode = new Date(ev.startDate);
            const eNode = new Date(ev.endDate);
            if (sNode <= lastOfIdx && eNode >= firstOfIdx) {
                individualMonthCounter++;
            }
        }
    });
    document.getElementById('metric-my-total').innerText = individualMonthCounter;

    const baselineMaxEvents = 8;
    const fillPercentage = Math.min((individualMonthCounter / baselineMaxEvents) * 100, 100);
    document.getElementById('hype-bar-fill').style.width = `${fillPercentage}%`;
    
    let labelText = "Chill Month 🧊";
    if (individualMonthCounter >= 7) labelText = "Absolute Hype! 🔥";
    else if (individualMonthCounter >= 4) labelText = "Active Mode 🏃";
    else if (individualMonthCounter > 0) labelText = "Steady Pace 🗺️";
    document.getElementById('hype-label').innerText = labelText;
}

function renderCalendar() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const daysContainer = document.getElementById('calendar-days');
    if (!daysContainer) return;
    daysContainer.innerHTML = '';
    document.querySelectorAll('.view-pill').forEach(btn => btn.classList.toggle('active', btn.dataset.view === currentCalendarView));

    const today = new Date();
    const todayString = formatDateString(today.getFullYear(), today.getMonth(), today.getDate());
    const hexMapColors = { personal: '#2e7d32', social: '#c2185b', work: '#283593', fitness: '#ef6c00', camping: '#a27b5c', hiking: '#3e4a3d' };

    if (currentCalendarView === 'agenda') {
        document.getElementById('month-year-label').innerText = `Agenda · ${monthNames[month]} ${year}`;
        daysContainer.className = 'days-grid agenda-view-grid';
        const upcoming = Object.entries(calendarEvents).filter(([id, ev]) => ev.endDate >= todayString && passesScopeFilter(ev))
            .sort((a,b) => a[1].startDate.localeCompare(b[1].startDate) || (a[1].time || '00:00').localeCompare(b[1].time || '00:00')).slice(0, 30);
        if (!upcoming.length) { daysContainer.innerHTML = '<div class="calendar-agenda-card">No upcoming plans found.</div>'; return; }
        upcoming.forEach(([eventId, ev]) => {
            const card = document.createElement('div');
            card.className = `calendar-agenda-card cat-${ev.category || 'personal'}`;
            card.innerHTML = `<strong>${escapeHTML(ev.title)}</strong><span>${escapeHTML(ev.startDate)}${ev.time ? ' · ' + escapeHTML(ev.time) : ''}</span><small>@${escapeHTML(ev.owner || 'unknown')}</small>${buildInviteStatusHTML(ev, eventId)}`;
            daysContainer.appendChild(card);
        });
        return;
    }

    if (currentCalendarView === 'week') {
        const weekStart = new Date(selectedDate);
        weekStart.setDate(selectedDate.getDate() - selectedDate.getDay());
        const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
        document.getElementById('month-year-label').innerText = `Week of ${monthNames[weekStart.getMonth()]} ${weekStart.getDate()}, ${weekStart.getFullYear()}`;
        daysContainer.className = 'days-grid week-view-grid';
        for (let i = 0; i < 7; i++) {
            const d = new Date(weekStart); d.setDate(weekStart.getDate() + i);
            const dateString = formatDateString(d.getFullYear(), d.getMonth(), d.getDate());
            const dayDiv = document.createElement('div');
            dayDiv.className = 'day week-day-card';
            if (dateString === todayString) dayDiv.classList.add('today');
            if (dateString === formatDateString(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate())) dayDiv.classList.add('selected');
            const events = Object.values(calendarEvents).filter(ev => eventMatchesDate(ev, dateString) && passesScopeFilter(ev));
            dayDiv.innerHTML = `<b>${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]} ${d.getDate()}</b><span>${events.length} plan(s)</span>`;
            dayDiv.onclick = () => { selectedDate = d; currentDate = new Date(d); renderCalendar(); updateAgendaView(); };
            daysContainer.appendChild(dayDiv);
        }
        return;
    }

    daysContainer.className = 'days-grid';
    document.getElementById('month-year-label').innerText = `${monthNames[month]} ${year}`;
    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < firstDayIndex; i++) {
        const emptyDiv = document.createElement('div'); emptyDiv.className = 'day empty'; daysContainer.appendChild(emptyDiv);
    }
    for (let day = 1; day <= totalDays; day++) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'day';
        dayDiv.appendChild(document.createTextNode(day));
        const dateString = formatDateString(year, month, day);
        if (fetchedHolidays[dateString]) { dayDiv.classList.add('holiday'); dayDiv.title = fetchedHolidays[dateString]; }
        if (dateString === todayString) dayDiv.classList.add('today');
        if (day === selectedDate.getDate() && month === selectedDate.getMonth() && year === selectedDate.getFullYear()) dayDiv.classList.add('selected');
        let detectedCategoriesOnDate = new Set();
        Object.values(calendarEvents).forEach(ev => { if(passesScopeFilter(ev) && eventMatchesDate(ev, dateString) && ev.category) detectedCategoriesOnDate.add(ev.category); });
        if (detectedCategoriesOnDate.size > 0) {
            const dotsContainer = document.createElement('div'); dotsContainer.className = 'dots-matrix-holder';
            detectedCategoriesOnDate.forEach(cat => { const miniDot = document.createElement('span'); miniDot.className = 'micro-dot-node'; miniDot.style.backgroundColor = hexMapColors[cat] || '#b56576'; dotsContainer.appendChild(miniDot); });
            dayDiv.appendChild(dotsContainer);
        }
        dayDiv.onclick = () => selectDay(day);
        daysContainer.appendChild(dayDiv);
    }
}

function changeMonth(direction) { 
    currentDate.setMonth(currentDate.getMonth() + direction); 
    calculateMonthlyMetrics();
    renderCalendar(); 
}

function selectDay(day) { 
    selectedDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), day); 
    renderCalendar(); 
    updateAgendaView(); 
    
    const dateStr = formatDateString(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
    document.getElementById('newEventStartDate').value = dateStr;
    document.getElementById('newEventEndDate').value = dateStr;
}

function formatDateString(year, month, day) { return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }

function updateAgendaView() {
    const dateString = formatDateString(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
    document.getElementById('selected-date-label').innerText = `${monthNames[selectedDate.getMonth()]} ${selectedDate.getDate()} Schedule`;
    
    const listContainer = document.getElementById('eventList');
    listContainer.innerHTML = '';

    let entriesArray = Object.entries(calendarEvents).filter(([id, ev]) => {
        const matchesRange = (dateString >= ev.startDate && dateString <= ev.endDate);
        if (!matchesRange) return false;
        
        const participants = ev.participant ? ev.participant.split(',').map(p => p.trim()) : [];
        if (currentFilterScope === 'me' && ev.owner !== currentUser && !participants.includes(currentUser)) return false;
        if (currentFilterScope === 'specific' && ev.owner !== filteredTargetUser && !participants.includes(filteredTargetUser)) return false;
        
        return true;
    });

    if (entriesArray.length === 0) {
        listContainer.innerHTML = '<li class="no-events">No entries for this day.</li>';
        return;
    }

    entriesArray.sort((a, b) => {
        if (a[1].startDate !== b[1].startDate) return a[1].startDate.localeCompare(b[1].startDate);
        return (a[1].time || "00:00").localeCompare(b[1].time || "00:00");
    });

    entriesArray.forEach(([eventId, item]) => {
        const li = document.createElement('li');
        li.className = `event-item cat-${item.category || 'personal'}`;
        
        let timeHTML = item.time ? `<span class="time-badge">🕒 ${item.time}</span>` : '';
        
        let durationHTML = '';
        if (item.startDate !== item.endDate) {
            const [, sM, sD] = item.startDate.split('-');
            const [, eM, eD] = item.endDate.split('-');
            durationHTML = `<span class="time-badge" style="background:rgba(0,0,0,0.04); font-size:0.7rem;">📅 ${parseInt(sD)}/${parseInt(sM)} → ${parseInt(eD)}/${parseInt(eM)}</span>`;
        }

        const participants = getParticipantsArray(item);
        let participantHTML = participants.length > 0 ? `<span class="participant-tag">with @${participants.map(escapeHTML).join(', @')}</span>` : '';
        
        const isOwner = (item.owner === currentUser);
        const ownerBadgeClass = isOwner ? 'own-user' : 'foreign-user';
        const ownerLabelText = isOwner ? 'me' : `@${item.owner}`;
        let ownerHTML = `<span class="owner-identity-pill ${ownerBadgeClass}">👑 ${escapeHTML(ownerLabelText)}</span>`;

        let mentionBadgeHTML = '';
        if (participants.includes(currentUser)) {
            mentionBadgeHTML = `<span class="owner-identity-pill foreign-user" style="background:var(--accent-dark); color:#fff;">🏷️ Mentioned You</span>`;
        }

        let actionControlHTML = isOwner ? `
            <div class="action-icon-group">
                <button class="btn-action-link" title="Edit Event" onclick="initiateInlineEdit('${eventId}')">✏️</button>
                <button class="btn-action-link" title="Delete Event" onclick="deleteEvent('${eventId}')">×</button>
            </div>
        ` : `<div style="width:12px;"></div>`;

        li.innerHTML = `
            <div>
                ${timeHTML} ${durationHTML}
                <strong style="display:block; margin-top:2px;">${escapeHTML(item.title)}</strong>
                ${participantHTML} ${ownerHTML} ${mentionBadgeHTML} ${buildInviteStatusHTML(item, eventId)} ${buildExtendedMetaHTML(item)} ${buildEventUtilityActions(eventId, item)}
            </div>
            ${actionControlHTML}
        `;
        listContainer.appendChild(li);
    });
}

function evaluateSearchInputState() {
    const queryText = document.getElementById('incomingSearchInput').value.trim();
    document.getElementById('searchClearBtn').style.display = queryText ? 'block' : 'none';
    renderIncomingEventsPipeline();
}

function clearSearchQueryPipeline() {
    document.getElementById('incomingSearchInput').value = '';
    document.getElementById('searchClearBtn').style.display = 'none';
    renderIncomingEventsPipeline();
}

function renderIncomingEventsPipeline() {
    const pipelineContainer = document.getElementById('incomingEventList');
    if (!pipelineContainer) return;
    pipelineContainer.innerHTML = '';

    const filterQuery = document.getElementById('incomingSearchInput').value.trim().toLowerCase();
    const categoryFilter = document.getElementById('incomingCategoryFilter') ? document.getElementById('incomingCategoryFilter').value : '';
    const startFilter = document.getElementById('incomingStartFilter') ? document.getElementById('incomingStartFilter').value : '';
    const endFilter = document.getElementById('incomingEndFilter') ? document.getElementById('incomingEndFilter').value : '';
    const mineOnly = document.getElementById('incomingMineOnly') ? document.getElementById('incomingMineOnly').checked : false;
    const referenceClock = new Date();
    const boundaryTodayString = formatDateString(referenceClock.getFullYear(), referenceClock.getMonth(), referenceClock.getDate());

    let flattenedIncomingNodes = [];

    Object.entries(calendarEvents).forEach(([eventId, item]) => {
        if (item.endDate >= boundaryTodayString) {
            if (categoryFilter && item.category !== categoryFilter) return;
            if (startFilter && item.endDate < startFilter) return;
            if (endFilter && item.startDate > endFilter) return;
            if (mineOnly && !passesScopeFilter(item)) return;
            const matchesTitle = (item.title || '').toLowerCase().includes(filterQuery);
            const participants = item.participant ? item.participant.split(',').map(p => p.trim().toLowerCase()) : [];
            const matchesParticipant = participants.some(p => p.includes(filterQuery));
            const matchesOwner = (item.owner || '').toLowerCase().includes(filterQuery);
            const matchesLocation = (item.location || '').toLowerCase().includes(filterQuery);
            const matchesNotes = (item.notes || '').toLowerCase().includes(filterQuery);
            const matchesPriority = (item.priority || '').toLowerCase().includes(filterQuery);

            if (!filterQuery || matchesTitle || matchesParticipant || matchesOwner || matchesLocation || matchesNotes || matchesPriority) {
                flattenedIncomingNodes.push({ eventId, ...item });
            }
        }
    });

    flattenedIncomingNodes.sort((alpha, beta) => {
        if (alpha.startDate !== beta.startDate) return alpha.startDate.localeCompare(beta.startDate);
        return (alpha.time || "00:00").localeCompare(beta.time || "00:00");
    });

    if (flattenedIncomingNodes.length === 0) {
        pipelineContainer.innerHTML = '<li class="no-events">No matching incoming plans discovered.</li>';
        return;
    }

    flattenedIncomingNodes.forEach(item => {
        const li = document.createElement('li');
        li.className = `event-item cat-${item.category || 'personal'}`;
        
        let dateBadgeHTML = '';
        if (item.startDate === item.endDate) {
            const [, m, d] = item.startDate.split('-');
            const truncatedMonthName = monthNames[parseInt(m) - 1].substring(0, 3);
            dateBadgeHTML = `<span class="time-badge" style="background:#b56576; color:#fff; margin-right:4px;">${parseInt(d)} ${truncatedMonthName}</span>`;
        } else {
            const [, m1, d1] = item.startDate.split('-');
            const [, m2, d2] = item.endDate.split('-');
            const truncM1 = monthNames[parseInt(m1) - 1].substring(0, 3);
            const truncM2 = monthNames[parseInt(m2) - 1].substring(0, 3);
            dateBadgeHTML = `<span class="time-badge" style="background:#b56576; color:#fff; margin-right:4px; font-size:0.72rem;">${parseInt(d1)} ${truncM1} - ${parseInt(d2)} ${truncM2}</span>`;
        }
        
        let timeHTML = item.time ? `<span class="time-badge">${item.time}</span>` : '';
        const participants = getParticipantsArray(item);
        let participantHTML = participants.length > 0 ? `<span class="participant-tag">with @${participants.map(escapeHTML).join(', @')}</span>` : '';
        
        const isOwner = (item.owner === currentUser);
        const ownerBadgeClass = isOwner ? 'own-user' : 'foreign-user';
        const ownerLabelText = isOwner ? 'me' : `@${item.owner}`;
        let ownerHTML = `<span class="owner-identity-pill ${ownerBadgeClass}">👑 ${escapeHTML(ownerLabelText)}</span>`;

        let mentionBadgeHTML = '';
        if (participants.includes(currentUser)) {
            mentionBadgeHTML = `<span class="owner-identity-pill foreign-user" style="background:var(--accent-dark); color:#fff;">🏷️ Mentioned You</span>`;
        }

        let actionControlHTML = isOwner 
            ? `<button class="btn-action-link" title="Delete" onclick="deleteEvent('${item.eventId}')">×</button>` 
            : `<div style="width:12px;"></div>`;

        li.innerHTML = `
            <div>
                ${dateBadgeHTML} ${timeHTML}
                <strong style="display:block; margin-top:2px;">${escapeHTML(item.title)}</strong>
                ${participantHTML} ${ownerHTML} ${mentionBadgeHTML} ${buildInviteStatusHTML(item, item.eventId)} ${buildExtendedMetaHTML(item)} ${buildEventUtilityActions(item.eventId, item)}
            </div>
            ${actionControlHTML}
        `;
        pipelineContainer.appendChild(li);
    });
}

function handleFormSubmission() {
    if (activeEditingNode.eventId) { processEventMutationUpdate(); } else { addNewEvent(); }
}

function addNewEvent() {
    const titleInput = document.getElementById('newEventInput');
    const participantInput = document.getElementById('newEventParticipant');
    const sDateInput = document.getElementById('newEventStartDate');
    const eDateInput = document.getElementById('newEventEndDate');
    const timeInput = document.getElementById('newEventTime');
    const catSelect = document.getElementById('newEventCategory');
    
    const titleText = titleInput.value.trim();
    if (!titleText) return;

    if (eDateInput.value < sDateInput.value) {
        alert("End date cannot occur before the start date boundary line!");
        return;
    }

    const payload = {
        title: titleText,
        participant: participantInput.value.trim(),
        startDate: sDateInput.value,
        endDate: eDateInput.value,
        time: timeInput.value.trim(),
        category: catSelect.value,
        priority: document.getElementById('newEventPriority') ? document.getElementById('newEventPriority').value : 'normal',
        location: document.getElementById('newEventLocation') ? document.getElementById('newEventLocation').value.trim() : '',
        notes: document.getElementById('newEventNotes') ? document.getElementById('newEventNotes').value.trim() : '',
        createdAt: new Date().toISOString(),
        owner: currentUser,
        inviteStatus: buildInviteStatus(getParticipantsArray({ participant: participantInput.value.trim() }))
    };

    if (database) { database.ref('shared_events_v3').push(payload); }
    titleInput.value = ''; 
    participantInput.value = ''; 
    timeInput.value = '';
    
    const selectAll = document.getElementById('selectAllOurCalendars');
    if(selectAll) { selectAll.checked = false; toggleCheckboxStyle(selectAll); }
    
    document.querySelectorAll('#participantCheckboxes .ourcalendar-checkbox').forEach(cb => {
        cb.checked = false;
        toggleCheckboxStyle(cb);
    });
}

function initiateInlineEdit(eventId) {
    const targetObject = calendarEvents[eventId];
    if (!targetObject) return;

    activeEditingNode = { eventId };
    
    document.getElementById('newEventInput').value = targetObject.title || '';
    document.getElementById('newEventStartDate').value = targetObject.startDate;
    document.getElementById('newEventEndDate').value = targetObject.endDate;
    document.getElementById('newEventTime').value = targetObject.time || '';
    document.getElementById('newEventCategory').value = targetObject.category || 'personal';
    if (document.getElementById('newEventPriority')) document.getElementById('newEventPriority').value = targetObject.priority || 'normal';
    if (document.getElementById('newEventLocation')) document.getElementById('newEventLocation').value = targetObject.location || '';
    if (document.getElementById('newEventNotes')) document.getElementById('newEventNotes').value = targetObject.notes || '';

    const pInput = document.getElementById('newEventParticipant');
    pInput.value = targetObject.participant || '';

    const pArray = targetObject.participant ? targetObject.participant.split(',').map(p => p.trim()) : [];
    document.querySelectorAll('#participantCheckboxes .ourcalendar-checkbox').forEach(cb => {
        cb.checked = pArray.includes(cb.value);
        toggleCheckboxStyle(cb);
    });
    
    updateParticipantField();

    const submitBtn = document.getElementById('submitActionBtn');
    submitBtn.innerText = "Update";
    submitBtn.classList.add('editing-mode');
    
    document.getElementById('cancelActionBtn').classList.remove('hidden');
    document.getElementById('newEventInput').focus();
}

function processEventMutationUpdate() {
    const { eventId } = activeEditingNode;
    if (!eventId) return;

    const titleInput = document.getElementById('newEventInput');
    const participantInput = document.getElementById('newEventParticipant');
    const sDateInput = document.getElementById('newEventStartDate');
    const eDateInput = document.getElementById('newEventEndDate');
    const timeInput = document.getElementById('newEventTime');
    const catSelect = document.getElementById('newEventCategory');

    if (eDateInput.value < sDateInput.value) {
        alert("End date cannot occur before the start date boundary line!");
        return;
    }

    const updatedPayload = {
        title: titleInput.value.trim(),
        participant: participantInput.value.trim(),
        startDate: sDateInput.value,
        endDate: eDateInput.value,
        time: timeInput.value.trim(),
        category: catSelect.value,
        priority: document.getElementById('newEventPriority') ? document.getElementById('newEventPriority').value : 'normal',
        location: document.getElementById('newEventLocation') ? document.getElementById('newEventLocation').value.trim() : '',
        notes: document.getElementById('newEventNotes') ? document.getElementById('newEventNotes').value.trim() : '',
        createdAt: calendarEvents[eventId]?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        owner: currentUser,
        inviteStatus: buildInviteStatus(getParticipantsArray({ participant: participantInput.value.trim() }), calendarEvents[eventId]?.inviteStatus || {})
    };

    if(database && updatedPayload.title) {
        database.ref(`shared_events_v3/${eventId}`).set(updatedPayload).then(() => {
            triggerToastAlert("Event Node Overhauled Successfully");
            resetFormMutatorState();
        });
    }
}

function resetFormMutatorState() {
    activeEditingNode = { eventId: null };
    document.getElementById('newEventInput').value = '';
    document.getElementById('newEventParticipant').value = '';
    document.getElementById('newEventTime').value = '';
    document.getElementById('newEventCategory').value = 'personal';
    if (document.getElementById('newEventPriority')) document.getElementById('newEventPriority').value = 'normal';
    if (document.getElementById('newEventLocation')) document.getElementById('newEventLocation').value = '';
    if (document.getElementById('newEventNotes')) document.getElementById('newEventNotes').value = '';

    const selectAll = document.getElementById('selectAllOurCalendars');
    if(selectAll) { selectAll.checked = false; toggleCheckboxStyle(selectAll); }
    
    document.querySelectorAll('#participantCheckboxes .ourcalendar-checkbox').forEach(cb => {
        cb.checked = false;
        toggleCheckboxStyle(cb);
    });

    const dateStr = formatDateString(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
    document.getElementById('newEventStartDate').value = dateStr;
    document.getElementById('newEventEndDate').value = dateStr;

    const submitBtn = document.getElementById('submitActionBtn');
    submitBtn.innerText = "Add";
    submitBtn.classList.remove('editing-mode');
    
    document.getElementById('cancelActionBtn').classList.add('hidden');
}

function respondToInvitation(eventId, status) {
    if (!database || !calendarEvents[eventId] || !currentUser) return;
    database.ref(`shared_events_v3/${eventId}/inviteStatus/${currentUser}`).set(status).then(() => {
        triggerToastAlert(`Invitation ${status}.`);
    });
}

function deleteEvent(eventId) {
    if (database) { database.ref(`shared_events_v3/${eventId}`).remove(); }
    if (activeEditingNode.eventId === eventId) { resetFormMutatorState(); }
}

function toggleChat() {
    const container = document.getElementById('chat-container');
    container.style.display = (container.style.display === 'flex') ? 'none' : 'flex';
}
function handleChatKey(e) { if (e.key === 'Enter') sendChatMessage(); }

function triggerChipCommand(cmdText) {
    appendMessage(cmdText, 'user');
    simulateBotProcessingThread(cmdText);
}

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const userText = input.value.trim();
    if (!userText) return;
    appendMessage(userText, 'user');
    input.value = '';
    simulateBotProcessingThread(userText);
}

function appendMessage(text, sender) {
    const msgContainer = document.getElementById('chatMessages');
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${sender}`;
    msgDiv.innerHTML = text;
    msgContainer.appendChild(msgDiv);
    msgContainer.scrollTop = msgContainer.scrollHeight;
    return msgDiv;
}

function simulateBotProcessingThread(userText) {
    const placeholderNode = appendMessage("<i>Thinking... 🧠</i>", "bot");
    setTimeout(() => {
        placeholderNode.remove();
        processBotLogic(userText);
    }, 800);
}

function checkMonthInText(str) {
    for (let i = 0; i < 12; i++) { 
        if (str.includes(fullMonthsKey[i]) || str.includes(monthsKey[i]) || str.includes(malayMonthsKey[i])) return i; 
    }
    return null;
}

function processBotLogic(text) {
    const cleanText = text.toLowerCase().trim();
    if (!currentUser) { appendMessage("Session missing. Re-log into execution gateway.", "bot"); return; }

    if (cleanText === 'help' || cleanText === 'commands' || cleanText === 'menu' || cleanText === 'tolong') {
        appendMessage(`🤖 <b>OurCalendarBot Manual Directory:</b><br><br>
            • <b>Telemetry Status:</b> <code>today</code><br>
            • <b>Overview:</b> <code>summary</code><br>
            • <b>Lookup Availability:</b> <i>"who is free on 20 June 2026?"</i><br>
            • <b>Add Event:</b> <i>"add Meeting on 18 June at 2pm"</i><br>
            • <b>Delete Single Event:</b> <i>"delete Meeting"</i><br>
            • <b>Complete Wipeout:</b> <i>"clear all my events"</i>`, 'bot');
        return;
    }

    if (cleanText === 'today' || cleanText === 'status' || cleanText === 'schedule') {
        const nowClock = new Date();
        const formatStr = formatDateString(nowClock.getFullYear(), nowClock.getMonth(), nowClock.getDate());
        
        let todaysEvents = Object.values(calendarEvents).filter(ev => {
            const participants = ev.participant ? ev.participant.split(',').map(p => p.trim()) : [];
            return (ev.owner === currentUser || participants.includes(currentUser)) && formatStr >= ev.startDate && formatStr <= ev.endDate;
        });

        if (todaysEvents.length === 0) {
            appendMessage("📊 <b>Live Briefing:</b> Your schedule is totally empty for today! You're completely free.", "bot");
        } else {
            let briefingList = todaysEvents.map(e => `• <b>${e.title}</b> ${e.time ? `[🕒 ${e.time}]` : ''} ${e.owner !== currentUser ? `(by @${e.owner})` : ''}`).join('<br>');
            appendMessage("📊 <b>Live Briefing:</b> You have <b>" + todaysEvents.length + "</b> plan(s) active today:<br><br>" + briefingList, "bot");
        }
        return;
    }

    if (cleanText === 'summary' || cleanText === 'summarize' || cleanText === 'rumusan') {
        const activeYear = currentDate.getFullYear();
        const activeMonthIdx = currentDate.getMonth();
        const targetMonthLabel = monthNames[activeMonthIdx];
        
        const firstDateStr = formatDateString(activeYear, activeMonthIdx, 1);
        const lastDateStr = formatDateString(activeYear, activeMonthIdx + 1, 0);

        let targetedMonthEvents = Object.values(calendarEvents).filter(ev => {
            const participants = ev.participant ? ev.participant.split(',').map(p => p.trim()) : [];
            const isUserAssociated = (ev.owner === currentUser || participants.includes(currentUser));
            return isUserAssociated && (ev.startDate <= lastDateStr && ev.endDate >= firstDateStr);
        });

        if (targetedMonthEvents.length === 0) {
            appendMessage(`📅 <b>Summary for ${targetMonthLabel} ${activeYear}:</b><br><br>No events are registered on your feed for this entire month!`, "bot");
            return;
        }

        let catMetrics = {};
        let mentionedCounter = 0;
        
        targetedMonthEvents.forEach(ev => {
            const participants = ev.participant ? ev.participant.split(',').map(p => p.trim()) : [];
            if (participants.includes(currentUser)) mentionedCounter++;
            const cat = ev.category || 'personal';
            catMetrics[cat] = (catMetrics[cat] || 0) + 1;
        });

        let breakdownHTML = Object.entries(catMetrics).map(([catName, count]) => {
            let icon = "🎯";
            if(catName === 'personal') icon = "🏠";
            if(catName === 'work') icon = "💼";
            if(catName === 'camping') icon = "🏕️";
            if(catName === 'hiking') icon = "🥾";
            if(catName === 'fitness') icon = "🏃";
            return `• ${icon} <b>${catName.toUpperCase()}</b>: ${count} plan(s)`;
        }).join('<br>');

        appendMessage(`📅 <b>Summary for ${targetMonthLabel} ${activeYear}:</b><br>
        You have a total of <b>${targetedMonthEvents.length} active plans</b> locked in.<br><br>
        <b>Category Breakdown:</b><br>${breakdownHTML}<br><br>
        🤝 Cross-Shared Actions: You were tagged/mentioned in <b>${mentionedCounter}</b> plans created by other users.`, "bot");
        return;
    }

    const isAvailabilityQuery = cleanText.includes('free') || cleanText.includes('busy') || 
                                cleanText.includes('siapa') || cleanText.includes('kosong');
                                
    if (isAvailabilityQuery) {
        let lookupYear = currentDate.getFullYear();
        let lookupMonth = currentDate.getMonth();
        let lookupDay = selectedDate.getDate();

        const explicitYearMatch = text.match(/\b(202\d)\b/);
        if (explicitYearMatch) lookupYear = parseInt(explicitYearMatch[1]);

        const monthIdx = checkMonthInText(cleanText);
        if (monthIdx !== null) lookupMonth = monthIdx;

        const dayMatch = text.match(/\b(\d{1,2})\b/);
        if (dayMatch) lookupDay = parseInt(dayMatch[1]);

        const parsedLookupDateStr = formatDateString(lookupYear, lookupMonth, lookupDay);
        const formattedDisplayDate = `${lookupDay} ${monthNames[lookupMonth]} ${lookupYear}`;

        let systemicOurCalendarList = new Set();
        let busyOurCalendarsMap = {};

        Object.values(calendarEvents).forEach(ev => {
            if (ev.owner) systemicOurCalendarList.add(ev.owner);
            const participants = ev.participant ? ev.participant.split(',').map(p => p.trim()) : [];
            participants.forEach(p => { if(p) systemicOurCalendarList.add(p); });

            if (parsedLookupDateStr >= ev.startDate && parsedLookupDateStr <= ev.endDate) {
                if (ev.owner) {
                    if (!busyOurCalendarsMap[ev.owner]) busyOurCalendarsMap[ev.owner] = [];
                    busyOurCalendarsMap[ev.owner].push(ev.title);
                }
                participants.forEach(p => {
                    if (p) {
                        if (!busyOurCalendarsMap[p]) busyOurCalendarsMap[p] = [];
                        busyOurCalendarsMap[p].push(ev.title);
                    }
                });
            }
        });

        let busyListHTML = [];
        let freeListHTML = [];

        systemicOurCalendarList.forEach(user => {
            if (busyOurCalendarsMap[user]) {
                const uniquePlans = Array.from(new Set(busyOurCalendarsMap[user]));
                busyListHTML.push(`• 🔴 <b>@${user}</b> is tied up with: <i>"${uniquePlans.join(', ')}"</i>`);
            } else {
                freeListHTML.push(`• 🟢 <b>@${user}</b>`);
            }
        });

        let ultimateResponse = `🔍 <b>Availability Report for ${formattedDisplayDate}:</b><br><br>`;
        
        if (busyListHTML.length > 0) {
            ultimateResponse += `<b>Occupied Users (Not Free):</b><br>${busyListHTML.join('<br>')}<br><br>`;
        } else {
            ultimateResponse += `<b>Occupied Users:</b> None! Everyone is free.<br><br>`;
        }

        if (freeListHTML.length > 0) {
            ultimateResponse += `<b>Completely Free Users:</b><br>${freeListHTML.join('<br>')}--`;
        } else {
            ultimateResponse += `<b>Completely Free Users:</b> Nobody is free on this date!`;
        }

        appendMessage(ultimateResponse, "bot");
        return;
    }

    const isDeleteIntent = cleanText.includes('delete') || cleanText.includes('clear') || 
                           cleanText.includes('remove') || cleanText.includes('padam') || 
                           cleanText.includes('buang');
                           
    if (isDeleteIntent) {
        if (!database) { appendMessage("Database communication line disconnected.", "bot"); return; }

        if (cleanText.includes('all my events') || cleanText.includes('all events') || cleanText.includes('semua')) {
            let targets = Object.entries(calendarEvents).filter(([, ev]) => ev.owner === currentUser);
            if (targets.length === 0) {
                appendMessage("Verification complete: You do not have any active events to clear.", "bot");
            } else {
                targets.forEach(([id]) => database.ref(`shared_events_v3/${id}`).remove());
                appendMessage(`💥 <b>Wipeout Successful!</b> Cleared all (${targets.length}) events owned by @${currentUser}.`, 'bot');
            }
            return;
        } else {
            const triggerPrefixes = ['delete', 'clear', 'remove', 'padam', 'buang'];
            let parsedTargetTitle = cleanText;
            
            triggerPrefixes.forEach(prefix => {
                if (parsedTargetTitle.startsWith(prefix + ' ')) {
                    parsedTargetTitle = parsedTargetTitle.substring(prefix.length + 1).trim();
                }
            });

            if (!parsedTargetTitle) {
                appendMessage("Please specify which project to drop! E.g., <i>'delete Gym session'</i>", "bot");
                return;
            }

            let targetEntries = Object.entries(calendarEvents).filter(([, ev]) => 
                ev.owner === currentUser && ev.title.toLowerCase().includes(parsedTargetTitle)
            );

            if (targetEntries.length === 0) {
                appendMessage(`Could not locate any personal events matching the string: <b>"${parsedTargetTitle}"</b>.`, "bot");
            } else {
                targetEntries.forEach(([id]) => database.ref(`shared_events_v3/${id}`).remove());
                appendMessage(`🗑️ Removed <b>${targetEntries.length}</b> event(s) matching "${parsedTargetTitle}" from cloud registers.`, 'bot');
            }
            return;
        }
    }

    const isSchedulingIntent = cleanText.includes('add') || cleanText.includes('schedule') || 
                               cleanText.includes('camping') || cleanText.includes('tambah') || 
                               cleanText.includes('buat') || cleanText.includes('jadual');

    if (isSchedulingIntent) {
        let title = "Cloud Planned Entry"; let participant = ""; let time = "";
        let startMonth = currentDate.getMonth(); let startDayNum = selectedDate.getDate();
        let endMonth = startMonth; let endDayNum = startDayNum;

        let trackingString = text;
        if(!cleanText.includes('add') && !cleanText.includes('schedule') && !cleanText.includes('tambah') && !cleanText.includes('buat')) {
            trackingString = "add " + text;
        }

        const titleMatch = trackingString.match(/(?:add|schedule|tambah|buat|jadual)\s+(.*?)(?:\s+with|\s+dengan|\s+at|\s+pukul|\s+on|\s+pada|$)/i);
        if (titleMatch && titleMatch[1]) title = titleMatch[1].trim();
        
        const partMatch = text.match(/(?:with|dengan)\s+@?([a-zA-Z0-9_]+)/i);
        if (partMatch && partMatch[1]) participant = partMatch[1].trim().toLowerCase();
        
        const timeMatch = text.match(/(?:at|pukul)\s+(\d{1,2})[:.]?(\d{2})?\s*(?:pm|am|PM|AM)?/i);
        if (timeMatch) {
            let hours = parseInt(timeMatch[1]);
            let minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
            if (cleanText.includes('pm') && hours < 12) hours += 12;
            if (cleanText.includes('am') && hours === 12) hours = 0;
            time = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        }

        const dateMatch = text.match(/(?:on|pada)\s+(\d+)\s*([a-zA-Z]*)/i);
        if (dateMatch) {
            startDayNum = parseInt(dateMatch[1]);
            if (dateMatch[2]) { let m = checkMonthInText(dateMatch[2].toLowerCase()); if (m !== null) startMonth = m; }
            endDayNum = startDayNum;
            endMonth = startMonth;

            const rangeMatch = text.match(/(?:until|to|hingga)\s+(\d+)\s*([a-zA-Z]*)/i);
            if (rangeMatch) {
                endDayNum = parseInt(rangeMatch[1]);
                if (rangeMatch[2]) { let m = checkMonthInText(rangeMatch[2].toLowerCase()); if (m !== null) endMonth = m; }
                else { endMonth = startMonth; }
            }
        } else {
            let m = checkMonthInText(cleanText); if (m !== null) startMonth = m; endMonth = startMonth;
            const explicitDay = text.match(/\b(\d{1,2})\b/); if (explicitDay) { startDayNum = parseInt(explicitDay[1]); endDayNum = startDayNum; }
        }

        const startDateStr = formatDateString(currentDate.getFullYear(), startMonth, startDayNum);
        const endDateStr = formatDateString(currentDate.getFullYear(), endMonth, endDayNum);
        
        let timeClashDetected = false;
        if (time) {
            timeClashDetected = Object.values(calendarEvents).some(ev => 
                ev.owner === currentUser && 
                ev.startDate === startDateStr && 
                ev.time === time
            );
        }

        let responseWarningHTML = "";
        if (timeClashDetected) {
            responseWarningHTML = `<br>⚠️ <b>Warning:</b> Detected a time conflict on ${startDayNum} ${monthNames[startMonth]} at ${time}! Entry was still added.`;
        }

        let parsedCategory = 'social'; 
        if (cleanText.includes('gym') || cleanText.includes('run') || cleanText.includes('workout')) {
            parsedCategory = 'fitness';
        } else if (cleanText.includes('work') || cleanText.includes('meeting')) {
            parsedCategory = 'work';
        } else if (cleanText.includes('camp') || cleanText.includes('camping')) {
            parsedCategory = 'camping';
        } else if (cleanText.includes('hike') || cleanText.includes('hiking')) {
            parsedCategory = 'hiking';
        }

        const payload = { title, participant, startDate: startDateStr, endDate: endDateStr, time, category: parsedCategory, owner: currentUser, inviteStatus: buildInviteStatus(getParticipantsArray({ participant })) };

        if (database) { database.ref('shared_events_v3').push(payload); }

        currentDate.setMonth(startMonth);
        selectedDate = new Date(currentDate.getFullYear(), startMonth, startDayNum);

        appendMessage(`🚀 Timeline mapped! Added <b>"${title}"</b> from ${startDayNum} ${monthNames[startMonth]} to ${endDayNum} ${monthNames[endMonth]}.${responseWarningHTML}`, 'bot');
        return;
    }

    appendMessage("Unrecognized statement format. Type <code>help</code> to display matching functions.", 'bot');
}

/* OurCalendar Planner v3 enhancement layer: event metadata, export/import, ICS, duplicate, print agenda. */

function buildEventUtilityActions(eventId, item) {
    // Safe fallback stub method to prevent runtime ReferenceErrors during item rendering
    return '';
}

function getVisibleUpcomingEvents() {
    const today = new Date();
    const todayString = formatDateString(today.getFullYear(), today.getMonth(), today.getDate());
    return Object.entries(calendarEvents)
        .filter(([id, ev]) => ev.endDate >= todayString && passesScopeFilter(ev))
        .sort((a,b) => a[1].startDate.localeCompare(b[1].startDate) || (a[1].time || '00:00').localeCompare(b[1].time || '00:00'));
}


// Function to show/hide the developer control panel manually
function toggleDeveloperPanel() {
    const adminPanel = document.getElementById('developerAdminPanel');
    if (!adminPanel) return;
    
    const isHidden = adminPanel.classList.toggle('hidden');
    
    // Optional: Keep active users list filled when turning panel on
    if (!isHidden && typeof loadAdminUserList === 'function') {
        loadAdminUserList();
    }
}

// Controls background track playback
function toggleMusic() {
    const audio = document.getElementById('ourcalendarAudioEngine');
    const musicBtn = document.getElementById('musicToggleBtn');
    
    if (!audio || !musicBtn) return;

    if (audio.paused) {
        // Modern browsers block autoplay until a user interacts with the page
        audio.play().then(() => {
            musicBtn.textContent = '⏸️'; // Change icon to pause when playing
            if (typeof triggerToastAlert === 'function') {
                triggerToastAlert('Playing track... 🎵');
            }
        }).catch(error => {
            console.error("Playback restriction encountered:", error);
            if (typeof triggerToastAlert === 'function') {
                triggerToastAlert('Audio interaction required ⚠️');
            }
        });
    } else {
        audio.pause();
        musicBtn.textContent = '🎵'; // Revert back to music icon when paused
    }
}