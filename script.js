const OURCALENDAR_VERSION = '5.0.0';
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_EVENT = 12;
const STORAGE_KEYS = Object.freeze({
    events: 'ourcalendarCachedEventsV5',
    holidays: 'ourcalendarHolidayCacheV5',
    holidaySettings: 'ourcalendarHolidaySettingsV5',
    offlineQueue: 'ourcalendarOfflineQueueV5',
    collaboration: 'ourcalendarCollaborationCacheV5'
});

function readLocalJSON(key, fallbackValue) {
    try {
        const storedValue = localStorage.getItem(key);
        if (!storedValue) return fallbackValue;
        return JSON.parse(storedValue);
    } catch (error) {
        console.warn(`Unable to read local cache: ${key}`, error);
        return fallbackValue;
    }
}

function writeLocalJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (error) {
        console.warn(`Unable to write local cache: ${key}`, error);
        return false;
    }
}

let fetchedHolidays = {};
let rawHolidayRecords = [];
let holidayRequestSerial = 0;
let holidaySettings = {
    enabled: true,
    country: 'MY',
    scope: 'national',
    ...readLocalJSON(STORAGE_KEYS.holidaySettings, {})
};
if (!/^[A-Z]{2}$/.test(String(holidaySettings.country || ''))) holidaySettings.country = 'MY';
if (!['national', 'all'].includes(holidaySettings.scope)) holidaySettings.scope = 'national';
holidaySettings.enabled = holidaySettings.enabled !== false;

let countdownInterval = null;
let deferredInstallPrompt = null;
let serviceWorkerRegistration = null;
let pendingServiceWorker = null;
let pwaControllerReloading = false;
let offlineQueueFlushActive = false;
let offlineOperations = readLocalJSON(STORAGE_KEYS.offlineQueue, []);
if (!Array.isArray(offlineOperations)) offlineOperations = [];

let activeDetailEventId = null;
let activeDetailOccurrenceDate = '';
let activeCollaborationData = { comments: {}, attachments: {} };
let collaborationListenerRef = null;
let collaborationCache = readLocalJSON(STORAGE_KEYS.collaboration, {});
if (!collaborationCache || typeof collaborationCache !== 'object' || Array.isArray(collaborationCache)) collaborationCache = {};

const firebaseConfig = {
    apiKey: "AIzaSyD7fcmeJe6C-XWLBMq213panWHZekLA_mo",
    authDomain: "trip-planner-edb3f.firebaseapp.com",
    databaseURL: "https://trip-planner-edb3f-default-rtdb.firebaseio.com",
    projectId: "trip-planner-edb3f",
    storageBucket: "trip-planner-edb3f.firebasestorage.app",
    messagingSenderId: "829260334284",
    appId: "1:829260334284:web:2387028c35baa339ce6e69",
    measurementId: "G-6GHDBVXPVV"
};

let database = null;
try {
    firebase.initializeApp(firebaseConfig);
    database = firebase.database();
} catch(e) {
    console.error("Firebase startup structural protocol halted.", e);
}

let currentUser = localStorage.getItem('ourcalendarSharedCloudUser') || localStorage.getItem('broskiSharedCloudUser') || null;
let currentDate = new Date();
let selectedDate = new Date();
let calendarEvents = {}; 
let baselineDataTrackingObject = null; 
let currentFilterScope = 'all'; 
let filteredTargetUser = ''; 
let systemMutedOnInit = true;   
let activeEditingNode = { eventId: null }; 

if(localStorage.getItem('ourcalendarDarkThemeActive') === 'true' || localStorage.getItem('broskiDarkThemeActive') === 'true') {
    document.body.classList.add('dark-mode');
}

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthsKey = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const fullMonthsKey = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const malayMonthsKey = ["januari", "februari", "mac", "april", "mei", "jun", "julai", "ogos", "september", "oktober", "november", "disember"];

// ----------------------------------------------------
// Offline cache, public holidays, and PWA engine v5.0
// ----------------------------------------------------

function generateLocalKey(prefix = 'item') {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${Date.now()}_${randomPart}`;
}

function isBrowserOnline() {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

function persistCalendarCache() {
    writeLocalJSON(STORAGE_KEYS.events, calendarEvents || {});
}

function applyPendingEventOperations(baseEvents) {
    const mergedEvents = { ...(baseEvents || {}) };
    offlineOperations.forEach(operation => {
        const match = /^shared_events_v3\/([^/]+)$/.exec(operation.path || '');
        if (!match) return;
        const eventId = match[1];
        if (operation.value === null) delete mergedEvents[eventId];
        else mergedEvents[eventId] = operation.value;
    });
    return mergedEvents;
}

function hydrateCalendarFromCache() {
    const cachedEvents = readLocalJSON(STORAGE_KEYS.events, {});
    if (!cachedEvents || typeof cachedEvents !== 'object' || Array.isArray(cachedEvents)) return false;
    if (Object.keys(cachedEvents).length === 0) return false;

    calendarEvents = applyPendingEventOperations(cachedEvents);
    baselineDataTrackingObject = { ...calendarEvents };
    refreshAllCalendarViews();
    return true;
}

function refreshAllCalendarViews() {
    if (!document.getElementById('app-container') || document.getElementById('app-container').classList.contains('hidden')) return;
    populateUserFilterDropdown();
    calculateMonthlyMetrics();
    renderCalendar();
    updateAgendaView();
    renderIncomingEventsPipeline();
    calculateActiveTodayAlertsBanner();
    updateNextAdventureCountdown();

    if (activeDetailEventId && calendarEvents[activeDetailEventId]) {
        renderEventDetailSummary(calendarEvents[activeDetailEventId], activeDetailOccurrenceDate);
    }
}

function persistOfflineQueue() {
    writeLocalJSON(STORAGE_KEYS.offlineQueue, offlineOperations);
    updateNetworkStatusIndicator();
}

function queueOfflineOperation(path, value, description = 'Pending change') {
    // The newest write to the exact same path supersedes older pending writes.
    offlineOperations = offlineOperations.filter(operation => operation.path !== path);
    offlineOperations.push({
        id: generateLocalKey('queue'),
        path,
        value: value === undefined ? null : value,
        description,
        createdAt: Date.now()
    });
    persistOfflineQueue();
}

function isLikelyNetworkError(error) {
    const message = String(error && (error.code || error.message || error) || '').toLowerCase();
    return !isBrowserOnline() || message.includes('network') || message.includes('disconnected') || message.includes('unavailable');
}

async function writePathWithOfflineSupport(path, value, options = {}) {
    const allowOffline = options.allowOffline !== false;
    const description = options.description || 'Pending change';

    if (!database || !isBrowserOnline()) {
        if (!allowOffline) throw new Error('This action requires an internet connection.');
        queueOfflineOperation(path, value, description);
        return { queued: true };
    }

    try {
        await database.ref(path).set(value);
        return { queued: false };
    } catch (error) {
        if (allowOffline && isLikelyNetworkError(error)) {
            queueOfflineOperation(path, value, description);
            return { queued: true };
        }
        throw error;
    }
}

async function flushOfflineOperations() {
    if (offlineQueueFlushActive || !database || !isBrowserOnline() || offlineOperations.length === 0) {
        updateNetworkStatusIndicator();
        return;
    }

    offlineQueueFlushActive = true;
    updateNetworkStatusIndicator();
    let completedCount = 0;

    try {
        while (offlineOperations.length > 0 && isBrowserOnline()) {
            const operation = offlineOperations[0];
            try {
                await database.ref(operation.path).set(operation.value);
                offlineOperations.shift();
                completedCount += 1;
                persistOfflineQueue();
            } catch (error) {
                console.warn('Pending operation could not be synchronized.', operation, error);
                break;
            }
        }
    } finally {
        offlineQueueFlushActive = false;
        updateNetworkStatusIndicator();
    }

    if (completedCount > 0 && offlineOperations.length === 0) {
        triggerToastAlert(`${completedCount} offline change${completedCount === 1 ? '' : 's'} synchronized`);
    }
}

function updateNetworkStatusIndicator() {
    const online = isBrowserOnline();
    const pendingCount = offlineOperations.length;
    const indicator = document.getElementById('networkStatusIndicator');
    const loginNote = document.getElementById('loginOfflineNote');

    if (indicator) {
        indicator.classList.toggle('offline', !online);
        indicator.classList.toggle('sync-pending', online && pendingCount > 0);
        if (!online) indicator.textContent = pendingCount > 0 ? `Offline · ${pendingCount}` : 'Offline';
        else if (pendingCount > 0) indicator.textContent = offlineQueueFlushActive ? `Syncing ${pendingCount}` : `Pending ${pendingCount}`;
        else indicator.textContent = 'Online';
        indicator.title = pendingCount > 0
            ? `${pendingCount} change${pendingCount === 1 ? '' : 's'} waiting to synchronize`
            : (online ? 'Connected' : 'Using locally cached calendar data');
    }

    if (loginNote) {
        loginNote.textContent = online
            ? 'Install the app to keep the calendar shell and your latest schedule available offline.'
            : 'Offline mode: a previously signed-in profile can use locally cached calendar data.';
    }
}

async function saveEventRecord(eventId, payload, successMessage) {
    const hadPreviousRecord = Object.prototype.hasOwnProperty.call(calendarEvents, eventId);
    const previousRecord = calendarEvents[eventId];
    calendarEvents[eventId] = payload;
    persistCalendarCache();
    refreshAllCalendarViews();

    try {
        const result = await writePathWithOfflineSupport(`shared_events_v3/${eventId}`, payload, {
            description: `Save event: ${payload.title || eventId}`
        });
        triggerToastAlert(result.queued ? 'Saved offline — synchronization pending' : successMessage);
        return true;
    } catch (error) {
        if (hadPreviousRecord) calendarEvents[eventId] = previousRecord;
        else delete calendarEvents[eventId];
        persistCalendarCache();
        refreshAllCalendarViews();
        console.error('Unable to save event.', error);
        alert('Unable to save the event. Please check the database permissions and connection.');
        return false;
    }
}

function getHolidayCacheKey(year, countryCode) {
    return `${year}-${countryCode}`;
}

function getCachedHolidayBundle(year, countryCode) {
    const allCache = readLocalJSON(STORAGE_KEYS.holidays, {});
    return allCache[getHolidayCacheKey(year, countryCode)] || null;
}

function storeHolidayBundle(year, countryCode, records) {
    const allCache = readLocalJSON(STORAGE_KEYS.holidays, {});
    allCache[getHolidayCacheKey(year, countryCode)] = {
        fetchedAt: Date.now(),
        records
    };
    writeLocalJSON(STORAGE_KEYS.holidays, allCache);
}

const MALAYSIA_REGION_CODES = Object.freeze([
    'JHR', 'KDH', 'KTN', 'KUL', 'LBN', 'MLK', 'NSN', 'PHG',
    'PJY', 'PLS', 'PNG', 'PRK', 'SBH', 'SGR', 'SWK', 'TRG'
]);

function getHolidayRequestDetails(year, countryCode) {
    if (countryCode === 'MY') {
        return {
            url: `https://malaysia-holiday.dydxsoft.my/api/v1/holidays?year=${year}`,
            sourceName: 'Malaysia Holiday API'
        };
    }
    return {
        url: `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`,
        sourceName: 'Nager.Date'
    };
}

function normalizeHolidayResponse(payload, countryCode) {
    if (countryCode !== 'MY') {
        if (!Array.isArray(payload)) throw new Error('Unexpected holiday response format');
        return payload;
    }

    const sourceRecords = payload && Array.isArray(payload.data) ? payload.data : null;
    if (!sourceRecords) throw new Error('Unexpected Malaysia holiday response format');

    return sourceRecords.map(record => {
        const stateCodes = Array.isArray(record.state_codes) ? record.state_codes.filter(Boolean) : [];
        const isCountrywide = MALAYSIA_REGION_CODES.every(code => stateCodes.includes(code));
        return {
            date: record.date,
            name: record.name || 'Public holiday',
            localName: record.name || 'Public holiday',
            global: isCountrywide,
            counties: stateCodes,
            types: [isCountrywide ? 'Countrywide' : 'Regional'],
            subjectToChange: record.is_subject_to_change === true
        };
    });
}

function getHolidaySubdivisionCodes(record) {
    const codes = record && (record.subdivisionCodes || record.counties || record.state_codes);
    return Array.isArray(codes) ? codes.filter(Boolean) : [];
}

function isNationalHolidayRecord(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.global === true || record.nationalHoliday === true) return true;
    if (record.global === false || record.nationalHoliday === false) return false;
    return getHolidaySubdivisionCodes(record).length === 0;
}

function applyHolidayRecords(records, sourceLabel = '') {
    rawHolidayRecords = Array.isArray(records) ? records : [];
    fetchedHolidays = {};

    if (holidaySettings.enabled) {
        rawHolidayRecords.forEach(record => {
            const date = String(record && record.date || '');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
            if (holidaySettings.scope === 'national' && !isNationalHolidayRecord(record)) return;

            const holidayItem = {
                name: String(record.name || record.englishName || record.localName || 'Public holiday'),
                localName: String(record.localName || record.name || record.englishName || 'Public holiday'),
                global: isNationalHolidayRecord(record),
                subdivisions: getHolidaySubdivisionCodes(record),
                types: Array.isArray(record.types || record.holidayTypes) ? (record.types || record.holidayTypes) : []
            };

            if (!fetchedHolidays[date]) fetchedHolidays[date] = [];
            const duplicate = fetchedHolidays[date].some(existing => existing.name === holidayItem.name && existing.localName === holidayItem.localName);
            if (!duplicate) fetchedHolidays[date].push(holidayItem);
        });
    }

    const status = document.getElementById('holidayDataStatus');
    if (status && sourceLabel) status.textContent = sourceLabel;
    renderCalendar();
    updateAgendaView();
    renderHolidayMonthSummary();
}

function getHolidaysForDate(dateString) {
    return Array.isArray(fetchedHolidays[dateString]) ? fetchedHolidays[dateString] : [];
}

function setHolidayStatus(message, isError = false) {
    const status = document.getElementById('holidayDataStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('status-error', isError);
}

function initializeHolidayFeature() {
    const enabledToggle = document.getElementById('holidayEnabledToggle');
    const countrySelect = document.getElementById('holidayCountrySelect');
    const scopeSelect = document.getElementById('holidayScopeSelect');
    if (enabledToggle) enabledToggle.checked = holidaySettings.enabled;
    if (countrySelect) countrySelect.value = holidaySettings.country;
    if (scopeSelect) scopeSelect.value = holidaySettings.scope;
    loadHolidaysForVisibleYear(false);
}

async function loadHolidaysForVisibleYear(forceRefresh = false) {
    holidayRequestSerial += 1;
    const requestId = holidayRequestSerial;
    const year = currentDate.getFullYear();
    const countryCode = holidaySettings.country;

    if (!holidaySettings.enabled) {
        applyHolidayRecords([], 'Holiday display is turned off.');
        return;
    }

    const cachedBundle = getCachedHolidayBundle(year, countryCode);
    if (cachedBundle && Array.isArray(cachedBundle.records)) {
        const cachedDate = cachedBundle.fetchedAt ? new Date(cachedBundle.fetchedAt) : null;
        const dateLabel = cachedDate && !Number.isNaN(cachedDate.getTime())
            ? cachedDate.toLocaleDateString([], { day: 'numeric', month: 'short' })
            : 'earlier';
        applyHolidayRecords(cachedBundle.records, `Cached for ${year} · updated ${dateLabel}`);
        if (!forceRefresh && !isBrowserOnline()) return;
    } else {
        applyHolidayRecords([], isBrowserOnline() ? `Loading ${year} holidays…` : `No cached ${year} holiday data.`);
    }

    if (!isBrowserOnline()) {
        if (!cachedBundle) setHolidayStatus(`Offline — no cached ${year} holidays.`, true);
        return;
    }

    setHolidayStatus(`Loading ${year} holidays…`);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 12000) : null;

    try {
        const requestDetails = getHolidayRequestDetails(year, countryCode);
        const response = await fetch(requestDetails.url, {
            signal: controller ? controller.signal : undefined,
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`Holiday service returned ${response.status}`);
        const payload = await response.json();
        const records = normalizeHolidayResponse(payload, countryCode);

        storeHolidayBundle(year, countryCode, records);
        if (requestId !== holidayRequestSerial || year !== currentDate.getFullYear() || countryCode !== holidaySettings.country) return;
        applyHolidayRecords(records, `${requestDetails.sourceName} · ${year} · ${records.length} records`);
    } catch (error) {
        console.warn('Could not refresh public holidays.', error);
        if (requestId !== holidayRequestSerial) return;
        if (cachedBundle && Array.isArray(cachedBundle.records)) {
            applyHolidayRecords(cachedBundle.records, `Offline cache used for ${year}`);
        } else {
            applyHolidayRecords([], `Holiday service unavailable for ${year}.`);
            setHolidayStatus(`Holiday service unavailable for ${year}.`, true);
        }
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

function handleHolidaySettingsChange() {
    const enabledToggle = document.getElementById('holidayEnabledToggle');
    const countrySelect = document.getElementById('holidayCountrySelect');
    const scopeSelect = document.getElementById('holidayScopeSelect');

    holidaySettings.enabled = enabledToggle ? enabledToggle.checked : true;
    holidaySettings.country = countrySelect ? countrySelect.value : 'MY';
    holidaySettings.scope = scopeSelect ? scopeSelect.value : 'national';
    writeLocalJSON(STORAGE_KEYS.holidaySettings, holidaySettings);
    loadHolidaysForVisibleYear(false);
}

function refreshHolidayData() {
    loadHolidaysForVisibleYear(true);
}

function toggleHolidaySettings(forceOpen = false) {
    const panel = document.getElementById('holidaySettingsPanel');
    if (!panel) return;
    if (forceOpen) panel.classList.remove('hidden');
    else panel.classList.toggle('hidden');
    document.getElementById('holidaySettingsButton')?.classList.toggle('active', !panel.classList.contains('hidden'));
    if (!panel.classList.contains('hidden')) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderHolidayMonthSummary() {
    const summary = document.getElementById('holidayMonthSummary');
    const countBadge = document.getElementById('holidayMonthCount');
    if (!summary || !countBadge) return;

    const prefix = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-`;
    const monthEntries = Object.entries(fetchedHolidays)
        .filter(([date]) => date.startsWith(prefix))
        .sort(([firstDate], [secondDate]) => firstDate.localeCompare(secondDate));

    const holidayCount = monthEntries.reduce((count, [, items]) => count + items.length, 0);
    countBadge.textContent = String(holidayCount);
    countBadge.classList.toggle('has-items', holidayCount > 0);

    if (!holidaySettings.enabled || holidayCount === 0) {
        summary.classList.add('hidden');
        summary.innerHTML = '';
        return;
    }

    const previewItems = monthEntries.slice(0, 3).map(([date, items]) => {
        const day = Number(date.slice(-2));
        const names = items.map(item => item.name).join(' / ');
        return `<span><b>${day}</b> ${escapeHTML(names)}</span>`;
    });
    const remainder = monthEntries.length > 3 ? `<em>+${monthEntries.length - 3} more date${monthEntries.length - 3 === 1 ? '' : 's'}</em>` : '';
    summary.innerHTML = `<strong>🎌 ${holidayCount} holiday${holidayCount === 1 ? '' : 's'} this month</strong><div>${previewItems.join('')}${remainder}</div>`;
    summary.classList.remove('hidden');
}

function isRunningStandalone() {
    return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOSDevice() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

function setPwaInstallButtonsVisible(visible) {
    ['pwaInstallButton', 'loginPwaInstallButton'].forEach(id => {
        const button = document.getElementById(id);
        if (button) button.classList.toggle('hidden', !visible);
    });
}

function initializePwaExperience() {
    updateNetworkStatusIndicator();
    setPwaInstallButtonsVisible(!isRunningStandalone());
    registerOurCalendarServiceWorker();
}

async function promptPwaInstall() {
    if (isRunningStandalone()) {
        triggerToastAlert('OurCalendar is already installed');
        return;
    }

    if (deferredInstallPrompt) {
        const promptEvent = deferredInstallPrompt;
        deferredInstallPrompt = null;
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        if (choice.outcome === 'accepted') {
            setPwaInstallButtonsVisible(false);
            triggerToastAlert('OurCalendar installation started');
        } else {
            setPwaInstallButtonsVisible(true);
        }
        return;
    }

    openPwaHelp();
}

function openPwaHelp() {
    const modal = document.getElementById('pwaHelpModal');
    const content = document.getElementById('pwaHelpContent');
    if (!modal || !content) return;

    if (isIOSDevice()) {
        content.innerHTML = `
            <p>Install using Safari:</p>
            <ol>
                <li>Tap the <b>Share</b> button.</li>
                <li>Select <b>Add to Home Screen</b>.</li>
                <li>Tap <b>Add</b>.</li>
            </ol>
            <p class="pwa-help-note">Chrome and Edge on iPhone or iPad cannot show the direct installation prompt; open this page in Safari.</p>`;
    } else {
        content.innerHTML = `
            <p>Your browser has not offered the direct installation prompt yet.</p>
            <ol>
                <li>Open the browser menu.</li>
                <li>Select <b>Install OurCalendar</b> or <b>Add to Home screen</b>.</li>
                <li>Confirm the installation.</li>
            </ol>
            <p class="pwa-help-note">Installation requires the calendar to be opened through HTTPS or localhost, not directly as a file.</p>`;
    }

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
}

function closePwaHelp() {
    document.getElementById('pwaHelpModal')?.classList.add('hidden');
    if (document.getElementById('eventDetailModal')?.classList.contains('hidden')) document.body.classList.remove('modal-open');
}

function showAppUpdateBanner(worker) {
    pendingServiceWorker = worker || pendingServiceWorker;
    document.getElementById('appUpdateBanner')?.classList.remove('hidden');
}

function applyAppUpdate() {
    const worker = pendingServiceWorker || serviceWorkerRegistration?.waiting;
    if (worker) worker.postMessage({ type: 'SKIP_WAITING' });
    else window.location.reload();
}

async function registerOurCalendarServiceWorker() {
    if (!('serviceWorker' in navigator) || window.location.protocol === 'file:') return;

    try {
        serviceWorkerRegistration = await navigator.serviceWorker.register('./service-worker.js');
        if (serviceWorkerRegistration.waiting && navigator.serviceWorker.controller) {
            showAppUpdateBanner(serviceWorkerRegistration.waiting);
        }

        serviceWorkerRegistration.addEventListener('updatefound', () => {
            const installingWorker = serviceWorkerRegistration.installing;
            if (!installingWorker) return;
            installingWorker.addEventListener('statechange', () => {
                if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    showAppUpdateBanner(installingWorker);
                }
            });
        });

        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (pwaControllerReloading) return;
            pwaControllerReloading = true;
            window.location.reload();
        });
    } catch (error) {
        console.warn('Service worker registration skipped.', error);
    }
}

function goToToday() {
    const now = new Date();
    currentDate = new Date(now.getFullYear(), now.getMonth(), 1);
    selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    refreshAllCalendarViews();
    loadHolidaysForVisibleYear(false);

    const dateString = formatDateString(now.getFullYear(), now.getMonth(), now.getDate());
    const startInput = document.getElementById('newEventStartDate');
    const endInput = document.getElementById('newEventEndDate');
    if (startInput) startInput.value = dateString;
    if (endInput) endInput.value = dateString;
    handleStartDateChange();
}

function focusNewEventForm() {
    const input = document.getElementById('newEventInput');
    if (!input) return;
    document.getElementById('agendaContentWrapper')?.classList.remove('collapsed');
    document.getElementById('agendaHeaderNode')?.classList.remove('collapsed');
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => input.focus(), 250);
}

function handlePwaLaunchAction() {
    const action = new URLSearchParams(window.location.search).get('action');
    if (action === 'today') goToToday();
    if (action === 'new') setTimeout(focusNewEventForm, 250);
}

function handleModalBackdropClick(event, modalId) {
    if (event.target && event.target.id === modalId) {
        if (modalId === 'eventDetailModal') closeEventDetails();
        if (modalId === 'pwaHelpModal') closePwaHelp();
    }
}


// ----------------------------------------------------
// Recurring Event Engine v5.0
// ----------------------------------------------------

const WEEKDAY_SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const VALID_RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'];
const MAX_RECURRENCE_COUNT = 1000;
const MAX_RECURRENCE_GENERATION_GUARD = 20000;

function parseISODateParts(dateString) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));

    if (
        probe.getUTCFullYear() !== year ||
        probe.getUTCMonth() !== month - 1 ||
        probe.getUTCDate() !== day
    ) return null;

    return { year, month, day };
}

function isoDateToUTC(dateString) {
    const parts = parseISODateParts(dateString);
    return parts ? new Date(Date.UTC(parts.year, parts.month - 1, parts.day)) : null;
}

function utcDateToISO(dateObject) {
    if (!(dateObject instanceof Date) || Number.isNaN(dateObject.getTime())) return '';
    return `${dateObject.getUTCFullYear()}-${String(dateObject.getUTCMonth() + 1).padStart(2, '0')}-${String(dateObject.getUTCDate()).padStart(2, '0')}`;
}

function addDaysToDateString(dateString, amount) {
    const dateObject = isoDateToUTC(dateString);
    if (!dateObject) return '';
    dateObject.setUTCDate(dateObject.getUTCDate() + Number(amount || 0));
    return utcDateToISO(dateObject);
}

function differenceInCalendarDays(startDateString, endDateString) {
    const start = isoDateToUTC(startDateString);
    const end = isoDateToUTC(endDateString);
    if (!start || !end) return 0;
    return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function differenceInCalendarMonths(startDateString, endDateString) {
    const start = parseISODateParts(startDateString);
    const end = parseISODateParts(endDateString);
    if (!start || !end) return 0;
    return ((end.year - start.year) * 12) + (end.month - start.month);
}

function addMonthsClampedToDateString(dateString, amount) {
    const parts = parseISODateParts(dateString);
    if (!parts) return '';

    const targetFirst = new Date(Date.UTC(parts.year, (parts.month - 1) + Number(amount || 0), 1));
    const targetYear = targetFirst.getUTCFullYear();
    const targetMonth = targetFirst.getUTCMonth();
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const targetDay = Math.min(parts.day, lastDay);

    return utcDateToISO(new Date(Date.UTC(targetYear, targetMonth, targetDay)));
}

function addYearsClampedToDateString(dateString, amount) {
    const parts = parseISODateParts(dateString);
    if (!parts) return '';

    const targetYear = parts.year + Number(amount || 0);
    const lastDay = new Date(Date.UTC(targetYear, parts.month, 0)).getUTCDate();
    const targetDay = Math.min(parts.day, lastDay);

    return utcDateToISO(new Date(Date.UTC(targetYear, parts.month - 1, targetDay)));
}

function clampInteger(value, minimum, maximum, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, minimum), maximum);
}

function buildLocalEventDateTime(dateString, timeString) {
    const dateParts = parseISODateParts(dateString);
    if (!dateParts) return null;

    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(timeString || '00:00'));
    const hours = timeMatch ? clampInteger(timeMatch[1], 0, 23, 0) : 0;
    const minutes = timeMatch ? clampInteger(timeMatch[2], 0, 59, 0) : 0;

    return new Date(dateParts.year, dateParts.month - 1, dateParts.day, hours, minutes, 0, 0);
}

function getEventParticipants(eventObject) {
    return eventObject && eventObject.participant
        ? String(eventObject.participant).split(',').map(value => value.trim()).filter(Boolean)
        : [];
}

function isEventAssociatedWithUser(eventObject, username) {
    if (!eventObject || !username) return false;
    return eventObject.owner === username || getEventParticipants(eventObject).includes(username);
}

function eventMatchesCurrentScope(eventObject) {
    if (currentFilterScope === 'all') return true;
    if (currentFilterScope === 'me') return isEventAssociatedWithUser(eventObject, currentUser);
    if (currentFilterScope === 'specific') return isEventAssociatedWithUser(eventObject, filteredTargetUser);
    return true;
}

function normalizeRecurrence(eventObject) {
    if (!eventObject || !eventObject.recurrence) return null;

    const raw = typeof eventObject.recurrence === 'string'
        ? { frequency: eventObject.recurrence }
        : eventObject.recurrence;

    const frequency = String(raw.frequency || raw.type || 'none').toLowerCase();
    if (!VALID_RECURRENCE_FREQUENCIES.includes(frequency)) return null;

    const interval = clampInteger(raw.interval, 1, 99, 1);
    let weekdaySource = raw.weekdays;
    if (weekdaySource && !Array.isArray(weekdaySource) && typeof weekdaySource === 'object') {
        weekdaySource = Object.values(weekdaySource);
    }

    let weekdays = Array.isArray(weekdaySource)
        ? weekdaySource.map(value => Number.parseInt(value, 10)).filter(value => Number.isInteger(value) && value >= 0 && value <= 6)
        : [];
    weekdays = Array.from(new Set(weekdays)).sort((a, b) => a - b);

    if (frequency === 'weekly' && weekdays.length === 0) {
        const startDate = isoDateToUTC(eventObject.startDate);
        weekdays = [startDate ? startDate.getUTCDay() : 0];
    }

    let endType = String(raw.endType || '').toLowerCase();
    if (!['never', 'date', 'count'].includes(endType)) {
        endType = raw.until ? 'date' : (raw.count ? 'count' : 'never');
    }

    const until = parseISODateParts(raw.until) ? raw.until : '';
    const count = clampInteger(raw.count, 1, MAX_RECURRENCE_COUNT, 10);

    if (endType === 'date' && !until) endType = 'never';

    return {
        frequency,
        interval,
        weekdays,
        endType,
        until: endType === 'date' ? until : '',
        count: endType === 'count' ? count : null
    };
}

function isRecurringEvent(eventObject) {
    return normalizeRecurrence(eventObject) !== null;
}

function getEventDurationDays(eventObject) {
    if (!eventObject || !parseISODateParts(eventObject.startDate)) return 0;
    const endDate = parseISODateParts(eventObject.endDate) ? eventObject.endDate : eventObject.startDate;
    return Math.max(0, differenceInCalendarDays(eventObject.startDate, endDate));
}

function createOccurrenceNode(eventId, eventObject, occurrenceStartDate, occurrenceNumber) {
    const occurrenceEndDate = addDaysToDateString(occurrenceStartDate, getEventDurationDays(eventObject));
    return {
        ...eventObject,
        eventId,
        sourceEventId: eventId,
        seriesStartDate: eventObject.startDate,
        startDate: occurrenceStartDate,
        endDate: occurrenceEndDate,
        occurrenceStartDate,
        occurrenceEndDate,
        occurrenceNumber: occurrenceNumber || null,
        isRecurringOccurrence: isRecurringEvent(eventObject)
    };
}

function expandEventOccurrences(eventId, eventObject, rangeStartDate, rangeEndDate, options = {}) {
    if (!eventObject || !parseISODateParts(eventObject.startDate)) return [];
    if (!parseISODateParts(rangeStartDate) || !parseISODateParts(rangeEndDate) || rangeEndDate < rangeStartDate) return [];

    const baseStartDate = eventObject.startDate;
    const baseEndDate = parseISODateParts(eventObject.endDate) ? eventObject.endDate : baseStartDate;
    const durationDays = Math.max(0, differenceInCalendarDays(baseStartDate, baseEndDate));
    const recurrence = normalizeRecurrence(eventObject);
    const maxResults = clampInteger(options.maxResults, 1, 5000, 500);
    const occurrences = [];

    if (!recurrence) {
        if (baseStartDate <= rangeEndDate && baseEndDate >= rangeStartDate) {
            occurrences.push(createOccurrenceNode(eventId, eventObject, baseStartDate, 1));
        }
        return occurrences;
    }

    if (baseStartDate > rangeEndDate) return [];

    const scanStartDate = addDaysToDateString(rangeStartDate, -durationDays);

    const addCandidate = (candidateDate, occurrenceNumber) => {
        if (!candidateDate || candidateDate < baseStartDate) return 'continue';
        if (recurrence.endType === 'date' && candidateDate > recurrence.until) return 'stop';
        if (recurrence.endType === 'count' && occurrenceNumber > recurrence.count) return 'stop';
        if (candidateDate > rangeEndDate) return 'stop';

        const occurrenceEndDate = addDaysToDateString(candidateDate, durationDays);
        if (occurrenceEndDate >= rangeStartDate && candidateDate <= rangeEndDate) {
            occurrences.push(createOccurrenceNode(eventId, eventObject, candidateDate, occurrenceNumber));
            if (occurrences.length >= maxResults) return 'stop';
        }
        return 'continue';
    };

    if (recurrence.frequency === 'daily') {
        const dateDifference = differenceInCalendarDays(baseStartDate, scanStartDate);
        let recurrenceIndex = Math.max(0, Math.floor(dateDifference / recurrence.interval) - 1);
        let guard = 0;

        while (guard < MAX_RECURRENCE_GENERATION_GUARD) {
            const candidateDate = addDaysToDateString(baseStartDate, recurrenceIndex * recurrence.interval);
            const action = addCandidate(candidateDate, recurrenceIndex + 1);
            if (action === 'stop') break;
            recurrenceIndex += 1;
            guard += 1;
        }
    }

    if (recurrence.frequency === 'weekly') {
        const baseDateObject = isoDateToUTC(baseStartDate);
        const anchorWeekStart = addDaysToDateString(baseStartDate, -baseDateObject.getUTCDay());
        let activeWeekIndex = 0;
        let occurrenceNumber = 0;

        if (recurrence.endType !== 'count') {
            const daysFromAnchor = differenceInCalendarDays(anchorWeekStart, scanStartDate);
            const approximateWeekIndex = Math.max(0, Math.floor(daysFromAnchor / 7));
            const approximateCycle = Math.max(0, Math.floor(approximateWeekIndex / recurrence.interval) - 1);
            activeWeekIndex = approximateCycle * recurrence.interval;
        }

        let guard = 0;
        let shouldStop = false;
        while (!shouldStop && guard < MAX_RECURRENCE_GENERATION_GUARD) {
            const activeWeekStart = addDaysToDateString(anchorWeekStart, activeWeekIndex * 7);
            if (activeWeekStart > rangeEndDate) break;

            for (const weekday of recurrence.weekdays) {
                const candidateDate = addDaysToDateString(activeWeekStart, weekday);
                if (candidateDate < baseStartDate) continue;

                occurrenceNumber += 1;
                const action = addCandidate(candidateDate, occurrenceNumber);
                if (action === 'stop') {
                    shouldStop = true;
                    break;
                }
            }

            activeWeekIndex += recurrence.interval;
            guard += 1;
        }
    }

    if (recurrence.frequency === 'monthly') {
        const monthDifference = differenceInCalendarMonths(baseStartDate, scanStartDate);
        let recurrenceIndex = Math.max(0, Math.floor(monthDifference / recurrence.interval) - 1);
        let guard = 0;

        while (guard < MAX_RECURRENCE_GENERATION_GUARD) {
            const candidateDate = addMonthsClampedToDateString(baseStartDate, recurrenceIndex * recurrence.interval);
            const action = addCandidate(candidateDate, recurrenceIndex + 1);
            if (action === 'stop') break;
            recurrenceIndex += 1;
            guard += 1;
        }
    }

    if (recurrence.frequency === 'yearly') {
        const baseParts = parseISODateParts(baseStartDate);
        const scanParts = parseISODateParts(scanStartDate);
        const yearDifference = scanParts.year - baseParts.year;
        let recurrenceIndex = Math.max(0, Math.floor(yearDifference / recurrence.interval) - 1);
        let guard = 0;

        while (guard < MAX_RECURRENCE_GENERATION_GUARD) {
            const candidateDate = addYearsClampedToDateString(baseStartDate, recurrenceIndex * recurrence.interval);
            const action = addCandidate(candidateDate, recurrenceIndex + 1);
            if (action === 'stop') break;
            recurrenceIndex += 1;
            guard += 1;
        }
    }

    return occurrences;
}

function getOccurrencesBetween(rangeStartDate, rangeEndDate, eventFilter = null, options = {}) {
    const maxPerEvent = clampInteger(options.maxPerEvent, 1, 5000, 500);
    const maxTotal = clampInteger(options.maxTotal, 1, 20000, 5000);
    const results = [];

    Object.entries(calendarEvents).some(([eventId, eventObject]) => {
        if (typeof eventFilter === 'function' && !eventFilter(eventObject, eventId)) return false;
        const expanded = expandEventOccurrences(eventId, eventObject, rangeStartDate, rangeEndDate, { maxResults: maxPerEvent });
        results.push(...expanded);
        return results.length >= maxTotal;
    });

    return results.slice(0, maxTotal);
}

function getNextOccurrenceForEvent(eventId, eventObject, nowDate = new Date()) {
    const todayDate = formatDateString(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
    const horizonDate = addYearsClampedToDateString(todayDate, 120);
    const candidates = expandEventOccurrences(eventId, eventObject, todayDate, horizonDate, { maxResults: 128 });

    for (const occurrence of candidates) {
        const targetDateTime = buildLocalEventDateTime(occurrence.startDate, occurrence.time || '00:00');
        if (targetDateTime && targetDateTime.getTime() > nowDate.getTime()) {
            return { occurrence, targetDateTime };
        }
    }
    return null;
}

function eventOccursOnDate(eventObject, targetDate) {
    return expandEventOccurrences('', eventObject, targetDate, targetDate, { maxResults: 1 }).length > 0;
}

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[character]));
}

function formatHumanDate(dateString, includeYear = true) {
    const parts = parseISODateParts(dateString);
    if (!parts) return dateString || '';
    return `${parts.day} ${monthNames[parts.month - 1].substring(0, 3)}${includeYear ? ` ${parts.year}` : ''}`;
}

function describeRecurrence(eventObject) {
    const recurrence = normalizeRecurrence(eventObject);
    if (!recurrence) return 'Does not repeat';

    let description = '';
    const interval = recurrence.interval;

    if (recurrence.frequency === 'daily') {
        description = interval === 1 ? 'Every day' : `Every ${interval} days`;
    } else if (recurrence.frequency === 'weekly') {
        const dayLabels = recurrence.weekdays.map(day => WEEKDAY_SHORT_NAMES[day]).join(', ');
        description = interval === 1 ? `Every week on ${dayLabels}` : `Every ${interval} weeks on ${dayLabels}`;
    } else if (recurrence.frequency === 'monthly') {
        const startParts = parseISODateParts(eventObject.startDate);
        const dayLabel = startParts ? ` on day ${startParts.day}` : '';
        description = interval === 1 ? `Every month${dayLabel}` : `Every ${interval} months${dayLabel}`;
    } else if (recurrence.frequency === 'yearly') {
        const startParts = parseISODateParts(eventObject.startDate);
        const dateLabel = startParts ? ` on ${startParts.day} ${monthNames[startParts.month - 1].substring(0, 3)}` : '';
        description = interval === 1 ? `Every year${dateLabel}` : `Every ${interval} years${dateLabel}`;
    }

    if (recurrence.endType === 'date') description += ` • until ${formatHumanDate(recurrence.until)}`;
    if (recurrence.endType === 'count') description += ` • ${recurrence.count} occurrence${recurrence.count === 1 ? '' : 's'}`;
    return description;
}

function getSelectedRecurrenceWeekdays() {
    return Array.from(document.querySelectorAll('.recurrence-weekday-checkbox:checked'))
        .map(checkbox => Number.parseInt(checkbox.value, 10))
        .filter(value => Number.isInteger(value) && value >= 0 && value <= 6)
        .sort((a, b) => a - b);
}

function setSelectedRecurrenceWeekdays(weekdays) {
    const selectedSet = new Set((weekdays || []).map(value => Number.parseInt(value, 10)));
    document.querySelectorAll('.recurrence-weekday-checkbox').forEach(checkbox => {
        checkbox.checked = selectedSet.has(Number.parseInt(checkbox.value, 10));
    });
}

function selectDefaultRecurrenceWeekday() {
    if (getSelectedRecurrenceWeekdays().length > 0) return;
    const startDate = isoDateToUTC(document.getElementById('newEventStartDate').value);
    const defaultDay = startDate ? startDate.getUTCDay() : new Date().getDay();
    setSelectedRecurrenceWeekdays([defaultDay]);
}

function handleStartDateChange() {
    const startInput = document.getElementById('newEventStartDate');
    const endInput = document.getElementById('newEventEndDate');
    const untilInput = document.getElementById('recurrenceUntilDate');
    if (!startInput || !endInput) return;

    if (startInput.value && (!endInput.value || endInput.value < startInput.value)) {
        endInput.value = startInput.value;
    }

    if (untilInput && startInput.value) {
        untilInput.min = startInput.value;
        if (untilInput.value && untilInput.value < startInput.value) untilInput.value = startInput.value;
    }

    const recurrenceType = document.getElementById('newEventRecurrence');
    if (recurrenceType && recurrenceType.value === 'weekly') selectDefaultRecurrenceWeekday();
    updateRecurrenceSummary();
}

function handleRecurrenceControlChange() {
    const recurrenceSelect = document.getElementById('newEventRecurrence');
    const advancedOptions = document.getElementById('recurrenceAdvancedOptions');
    const weekdayBlock = document.getElementById('recurrenceWeekdayBlock');
    const intervalUnit = document.getElementById('recurrenceIntervalUnit');
    if (!recurrenceSelect || !advancedOptions) return;

    const frequency = recurrenceSelect.value;
    advancedOptions.classList.toggle('hidden', frequency === 'none');
    if (weekdayBlock) weekdayBlock.classList.toggle('hidden', frequency !== 'weekly');

    const unitMap = {
        daily: 'day(s)',
        weekly: 'week(s)',
        monthly: 'month(s)',
        yearly: 'year(s)'
    };
    if (intervalUnit) intervalUnit.textContent = unitMap[frequency] || 'time(s)';
    if (frequency === 'weekly') selectDefaultRecurrenceWeekday();

    handleRecurrenceEndTypeChange(false);
    updateRecurrenceSummary();
}

function handleRecurrenceEndTypeChange(shouldRefreshSummary = true) {
    const endTypeSelect = document.getElementById('recurrenceEndType');
    const untilBlock = document.getElementById('recurrenceUntilBlock');
    const countBlock = document.getElementById('recurrenceCountBlock');
    const untilInput = document.getElementById('recurrenceUntilDate');
    const startDate = document.getElementById('newEventStartDate')?.value || '';
    if (!endTypeSelect) return;

    const endType = endTypeSelect.value;
    if (untilBlock) untilBlock.classList.toggle('hidden', endType !== 'date');
    if (countBlock) countBlock.classList.toggle('hidden', endType !== 'count');

    if (endType === 'date' && untilInput) {
        untilInput.min = startDate;
        if (!untilInput.value || (startDate && untilInput.value < startDate)) {
            untilInput.value = startDate ? addYearsClampedToDateString(startDate, 1) : '';
        }
    }

    if (shouldRefreshSummary) updateRecurrenceSummary();
}

function readRecurrenceForm(showValidationAlert = true) {
    const recurrenceSelect = document.getElementById('newEventRecurrence');
    const frequency = recurrenceSelect ? recurrenceSelect.value : 'none';
    if (frequency === 'none') return { valid: true, recurrence: null };

    if (!VALID_RECURRENCE_FREQUENCIES.includes(frequency)) {
        if (showValidationAlert) alert('Please choose a valid recurrence frequency.');
        return { valid: false, recurrence: null, message: 'Invalid recurrence' };
    }

    const intervalInput = document.getElementById('recurrenceInterval');
    const interval = clampInteger(intervalInput?.value, 1, 99, 1);
    if (intervalInput) intervalInput.value = interval;

    const recurrence = {
        frequency,
        interval,
        endType: document.getElementById('recurrenceEndType')?.value || 'never'
    };

    if (frequency === 'weekly') {
        recurrence.weekdays = getSelectedRecurrenceWeekdays();
        if (recurrence.weekdays.length === 0) {
            if (showValidationAlert) alert('Please select at least one weekday for the weekly recurrence.');
            return { valid: false, recurrence: null, message: 'Choose at least one weekday' };
        }
    }

    const startDate = document.getElementById('newEventStartDate')?.value || '';
    if (recurrence.endType === 'date') {
        const untilDate = document.getElementById('recurrenceUntilDate')?.value || '';
        if (!parseISODateParts(untilDate) || (startDate && untilDate < startDate)) {
            if (showValidationAlert) alert('The recurrence end date must be on or after the event start date.');
            return { valid: false, recurrence: null, message: 'Select a valid end date' };
        }
        recurrence.until = untilDate;
    } else if (recurrence.endType === 'count') {
        const countInput = document.getElementById('recurrenceCount');
        const count = clampInteger(countInput?.value, 1, MAX_RECURRENCE_COUNT, 10);
        if (countInput) countInput.value = count;
        recurrence.count = count;
    } else {
        recurrence.endType = 'never';
    }

    return { valid: true, recurrence };
}

function updateRecurrenceSummary() {
    const badge = document.getElementById('recurrenceSummaryBadge');
    if (!badge) return;

    const result = readRecurrenceForm(false);
    if (!result.valid) {
        badge.textContent = result.message || 'Check recurrence settings';
        badge.title = badge.textContent;
        return;
    }

    const temporaryEvent = {
        startDate: document.getElementById('newEventStartDate')?.value || '',
        recurrence: result.recurrence
    };
    const summary = describeRecurrence(temporaryEvent);
    badge.textContent = summary;
    badge.title = summary;
}

function setRecurrenceFormFromEvent(eventObject) {
    const recurrence = normalizeRecurrence(eventObject);
    const recurrenceSelect = document.getElementById('newEventRecurrence');
    if (!recurrenceSelect) return;

    recurrenceSelect.value = recurrence ? recurrence.frequency : 'none';
    document.getElementById('recurrenceInterval').value = recurrence ? recurrence.interval : 1;
    document.getElementById('recurrenceEndType').value = recurrence ? recurrence.endType : 'never';
    document.getElementById('recurrenceUntilDate').value = recurrence && recurrence.endType === 'date' ? recurrence.until : '';
    document.getElementById('recurrenceCount').value = recurrence && recurrence.endType === 'count' ? recurrence.count : 10;
    setSelectedRecurrenceWeekdays(recurrence && recurrence.frequency === 'weekly' ? recurrence.weekdays : []);
    handleRecurrenceControlChange();
}

function resetRecurrenceForm() {
    const recurrenceSelect = document.getElementById('newEventRecurrence');
    if (!recurrenceSelect) return;

    recurrenceSelect.value = 'none';
    document.getElementById('recurrenceInterval').value = 1;
    document.getElementById('recurrenceEndType').value = 'never';
    document.getElementById('recurrenceUntilDate').value = '';
    document.getElementById('recurrenceCount').value = 10;
    setSelectedRecurrenceWeekdays([]);
    handleRecurrenceControlChange();
}

function buildEventPayloadFromForm(ownerUsername) {
    const titleText = document.getElementById('newEventInput').value.trim();
    const startDate = document.getElementById('newEventStartDate').value;
    const endDate = document.getElementById('newEventEndDate').value;

    if (!titleText) {
        alert('Please enter an event title.');
        return null;
    }
    if (!parseISODateParts(startDate) || !parseISODateParts(endDate)) {
        alert('Please select a valid start and end date.');
        return null;
    }
    if (endDate < startDate) {
        alert('End date cannot occur before the start date.');
        return null;
    }

    const recurrenceResult = readRecurrenceForm(true);
    if (!recurrenceResult.valid) return null;

    const payload = {
        title: titleText,
        participant: document.getElementById('newEventParticipant').value.trim(),
        startDate,
        endDate,
        time: document.getElementById('newEventTime').value.trim(),
        category: document.getElementById('newEventCategory').value,
        owner: ownerUsername
    };

    if (recurrenceResult.recurrence) payload.recurrence = recurrenceResult.recurrence;
    return payload;
}


window.addEventListener('load', () => {
    initializeHolidayFeature();
    initializePwaExperience();
    if (currentUser) bootApplicationView();
});

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
    document.body.classList.add('app-active');
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    document.getElementById('display-profile-tag').innerText = `@${currentUser}`;

    const today = new Date();
    currentDate = new Date(today.getFullYear(), today.getMonth(), 1);
    selectedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const todayStr = formatDateString(today.getFullYear(), today.getMonth(), today.getDate());
    document.getElementById('newEventStartDate').value = todayStr;
    document.getElementById('newEventEndDate').value = todayStr;
    resetRecurrenceForm();

    const adminPanel = document.getElementById('developerAdminPanel');
    if (currentUser === 'faiz') {
        adminPanel.classList.remove('hidden');
        loadAdminUserList();
    } else {
        adminPanel.classList.add('hidden');
    }

    hydrateCalendarFromCache();
    loadParticipantCheckboxes();
    establishLiveFirebaseListener();
    loadHolidaysForVisibleYear(false);
    updateNetworkStatusIndicator();
    flushOfflineOperations();
    handlePwaLaunchAction();
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
    
    // Manage dynamic styling for the master toggle itself
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
    
    // Automatically update the "Select All" checked state if users tick boxes manually
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

// ----------------------------------------------------

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
    closeEventDetails();
    document.body.classList.remove('app-active');
    localStorage.removeItem('ourcalendarSharedCloudUser');
    currentUser = null;
    if (database) {
        database.ref('shared_events_v3').off();
        database.ref('users').off();
    }
    if (countdownInterval) clearInterval(countdownInterval);
    document.getElementById('app-container').classList.add('hidden');
    document.getElementById('login-container').classList.remove('hidden');
    updateNetworkStatusIndicator();
}

function triggerToastAlert(message) {
    const toast = document.getElementById('networkToast');
    toast.innerHTML = `⚡ ${message}`;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3500);
}

function establishLiveFirebaseListener() {
    if (!database) {
        hydrateCalendarFromCache();
        updateNetworkStatusIndicator();
        return;
    }

    database.ref('shared_events_v3').off('value');
    database.ref('shared_events_v3').on('value', (snapshot) => {
        const cloudSnapshotData = snapshot.val() || {};
        const freshSnapshotData = applyPendingEventOperations(cloudSnapshotData);

        if (baselineDataTrackingObject !== null && !systemMutedOnInit) {
            Object.keys(freshSnapshotData).forEach(keyId => {
                if (!baselineDataTrackingObject.hasOwnProperty(keyId)) {
                    const freshlyAddedObject = freshSnapshotData[keyId];
                    if (freshlyAddedObject.owner !== currentUser) {
                        const participants = getEventParticipants(freshlyAddedObject);
                        if (participants.includes(currentUser)) {
                            triggerToastAlert(`🔔 @${freshlyAddedObject.owner} mentioned you in a plan: ${freshlyAddedObject.title}`);
                        } else {
                            triggerToastAlert(`📅 New event added by @${freshlyAddedObject.owner}: ${freshlyAddedObject.title}`);
                        }
                    }
                }
            });
        }

        baselineDataTrackingObject = { ...freshSnapshotData };
        calendarEvents = freshSnapshotData;
        systemMutedOnInit = false;
        persistCalendarCache();
        refreshAllCalendarViews();
        updateNetworkStatusIndicator();
    }, error => {
        console.warn('Live calendar listener unavailable. Cached events remain active.', error);
        hydrateCalendarFromCache();
        updateNetworkStatusIndicator();
    });
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
    let minimumDifference = Infinity;

    Object.entries(calendarEvents).forEach(([eventId, eventObject]) => {
        if (!isEventAssociatedWithUser(eventObject, currentUser)) return;

        const nextOccurrence = getNextOccurrenceForEvent(eventId, eventObject, now);
        if (!nextOccurrence) return;

        const difference = nextOccurrence.targetDateTime.getTime() - now.getTime();
        if (difference > 0 && difference < minimumDifference) {
            minimumDifference = difference;
            closestEvent = {
                ...nextOccurrence.occurrence,
                targetTime: nextOccurrence.targetDateTime
            };
        }
    });

    const widget = document.getElementById('nextEventCountdownWidget');
    if (!closestEvent) {
        widget.style.display = 'none';
        return;
    }

    widget.style.display = 'block';
    const recurrenceSuffix = closestEvent.isRecurringOccurrence ? ' 🔁' : '';
    document.getElementById('countdown-title').innerText = `"${closestEvent.title}"${recurrenceSuffix}`;

    function runCountdown() {
        const currentNow = new Date();
        const remainder = closestEvent.targetTime.getTime() - currentNow.getTime();

        if (remainder <= 0) {
            document.getElementById('countdown-timer-display').innerText = 'Adventure Active! 🚀';
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
    const todayDate = formatDateString(clock.getFullYear(), clock.getMonth(), clock.getDate());

    const matchingOccurrences = getOccurrencesBetween(
        todayDate,
        todayDate,
        eventObject => isEventAssociatedWithUser(eventObject, currentUser),
        { maxPerEvent: 50, maxTotal: 1000 }
    );

    const matchingTitles = Array.from(new Set(matchingOccurrences.map(occurrence => occurrence.title)));
    if (matchingTitles.length > 0) {
        banner.style.display = 'block';
        banner.innerHTML = `🎯 <b>Active Today:</b> ${matchingTitles.map(escapeHTML).join(', ')}`;
    } else {
        banner.style.display = 'none';
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
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth();
    const firstDate = formatDateString(currentYear, currentMonth, 1);
    const lastDate = formatDateString(currentYear, currentMonth + 1, 0);

    const individualMonthCounter = getOccurrencesBetween(
        firstDate,
        lastDate,
        eventObject => isEventAssociatedWithUser(eventObject, currentUser),
        { maxPerEvent: 1000, maxTotal: 10000 }
    ).length;

    document.getElementById('metric-my-total').innerText = individualMonthCounter;

    const baselineMaxEvents = 8;
    const fillPercentage = Math.min((individualMonthCounter / baselineMaxEvents) * 100, 100);
    document.getElementById('hype-bar-fill').style.width = `${fillPercentage}%`;

    let labelText = 'Chill Month 🧊';
    if (individualMonthCounter >= 7) labelText = 'Absolute Hype! 🔥';
    else if (individualMonthCounter >= 4) labelText = 'Active Mode 🏃';
    else if (individualMonthCounter > 0) labelText = 'Steady Pace 🗺️';
    document.getElementById('hype-label').innerText = labelText;
}

function renderCalendar() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const monthLabel = document.getElementById('month-year-label');
    const daysContainer = document.getElementById('calendar-days');
    if (!monthLabel || !daysContainer) return;

    monthLabel.innerText = `${monthNames[month]} ${year}`;
    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    daysContainer.innerHTML = '';

    for (let i = 0; i < firstDayIndex; i++) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'day empty';
        daysContainer.appendChild(emptyDiv);
    }

    const firstDate = formatDateString(year, month, 1);
    const lastDate = formatDateString(year, month + 1, 0);
    const monthOccurrences = getOccurrencesBetween(
        firstDate,
        lastDate,
        eventObject => eventMatchesCurrentScope(eventObject),
        { maxPerEvent: 1000, maxTotal: 10000 }
    );

    const categoriesByDate = {};
    monthOccurrences.forEach(occurrence => {
        let cursorDate = occurrence.startDate < firstDate ? firstDate : occurrence.startDate;
        const finalDate = occurrence.endDate > lastDate ? lastDate : occurrence.endDate;

        while (cursorDate && cursorDate <= finalDate) {
            if (!categoriesByDate[cursorDate]) categoriesByDate[cursorDate] = new Set();
            categoriesByDate[cursorDate].add(occurrence.category || 'personal');
            cursorDate = addDaysToDateString(cursorDate, 1);
        }
    });

    const today = new Date();
    const categoryColors = {
        personal: '#2e7d32',
        social: '#c2185b',
        work: '#283593',
        fitness: '#ef6c00',
        camping: '#a27b5c',
        hiking: '#3e4a3d'
    };

    for (let day = 1; day <= totalDays; day++) {
        const dayDiv = document.createElement('div');
        dayDiv.className = 'day';
        dayDiv.setAttribute('role', 'button');
        dayDiv.setAttribute('tabindex', '0');
        dayDiv.setAttribute('aria-label', `${day} ${monthNames[month]} ${year}`);

        const dayNumber = document.createElement('span');
        dayNumber.className = 'day-number-label';
        dayNumber.textContent = String(day);
        dayDiv.appendChild(dayNumber);

        const dateString = formatDateString(year, month, day);
        const holidayItems = getHolidaysForDate(dateString);
        if (holidayItems.length > 0) {
            dayDiv.classList.add('holiday');
            const holidayNames = holidayItems.map(item => item.name).join(' / ');
            dayDiv.title = holidayNames;
            dayDiv.setAttribute('aria-label', `${day} ${monthNames[month]} ${year}, ${holidayNames}`);
            const holidayMarker = document.createElement('span');
            holidayMarker.className = 'holiday-corner-marker';
            holidayMarker.textContent = '🎌';
            holidayMarker.setAttribute('aria-hidden', 'true');
            dayDiv.appendChild(holidayMarker);
        }

        if (day === today.getDate() && month === today.getMonth() && year === today.getFullYear()) dayDiv.classList.add('today');
        if (day === selectedDate.getDate() && month === selectedDate.getMonth() && year === selectedDate.getFullYear()) dayDiv.classList.add('selected');

        const detectedCategoriesOnDate = categoriesByDate[dateString] || new Set();
        if (detectedCategoriesOnDate.size > 0) {
            const dotsContainer = document.createElement('div');
            dotsContainer.className = 'dots-matrix-holder';
            detectedCategoriesOnDate.forEach(category => {
                const miniDot = document.createElement('span');
                miniDot.className = 'micro-dot-node';
                miniDot.style.backgroundColor = categoryColors[category] || '#b56576';
                dotsContainer.appendChild(miniDot);
            });
            dayDiv.appendChild(dotsContainer);
        }

        dayDiv.onclick = () => selectDay(day);
        dayDiv.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectDay(day);
            }
        };
        daysContainer.appendChild(dayDiv);
    }

    renderHolidayMonthSummary();
}

function changeMonth(direction) {
    currentDate.setMonth(currentDate.getMonth() + direction);
    calculateMonthlyMetrics();
    renderCalendar();
    loadHolidaysForVisibleYear(false);
}

function selectDay(day) {
    selectedDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
    renderCalendar();
    updateAgendaView();

    const dateStr = formatDateString(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
    document.getElementById('newEventStartDate').value = dateStr;
    document.getElementById('newEventEndDate').value = dateStr;
    handleStartDateChange();
}

function formatDateString(year, month, day) { return utcDateToISO(new Date(Date.UTC(year, month, day))); }

function buildEventActionControlsHTML(item) {
    const eventId = String(item.eventId || '');
    const occurrenceDate = String(item.occurrenceStartDate || item.startDate || '');
    const isOwner = item.owner === currentUser;
    const detailsButton = `<button class="btn-action-link collaboration-action" title="Open comments and attachments" aria-label="Open comments and attachments" onclick="openEventDetails('${eventId}', '${occurrenceDate}')">💬</button>`;
    const ownerButtons = isOwner ? `
        <button class="btn-action-link" title="Edit${item.isRecurringOccurrence ? ' recurring series' : ' event'}" aria-label="Edit event" onclick="initiateInlineEdit('${eventId}')">✏️</button>
        <button class="btn-action-link delete-action" title="Delete${item.isRecurringOccurrence ? ' recurring series' : ' event'}" aria-label="Delete event" onclick="deleteEvent('${eventId}')">×</button>` : '';
    return `<div class="action-icon-group">${detailsButton}${ownerButtons}</div>`;
}

function updateAgendaView() {
    const dateString = formatDateString(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
    const selectedLabel = document.getElementById('selected-date-label');
    const listContainer = document.getElementById('eventList');
    if (!selectedLabel || !listContainer) return;

    selectedLabel.innerText = `${monthNames[selectedDate.getMonth()]} ${selectedDate.getDate()} Schedule`;
    listContainer.innerHTML = '';

    const holidayItems = getHolidaysForDate(dateString);
    holidayItems.forEach(holiday => {
        const holidayNode = document.createElement('li');
        holidayNode.className = 'holiday-agenda-item';
        const scopeText = holiday.global ? 'Countrywide public holiday' : `Regional holiday${holiday.subdivisions.length ? ` · ${holiday.subdivisions.join(', ')}` : ''}`;
        holidayNode.innerHTML = `
            <div class="holiday-agenda-icon">🎌</div>
            <div><strong>${escapeHTML(holiday.name)}</strong><small>${escapeHTML(holiday.localName !== holiday.name ? holiday.localName : scopeText)}</small>${holiday.localName !== holiday.name ? `<small>${escapeHTML(scopeText)}</small>` : ''}</div>`;
        listContainer.appendChild(holidayNode);
    });

    const entriesArray = getOccurrencesBetween(
        dateString,
        dateString,
        eventObject => eventMatchesCurrentScope(eventObject),
        { maxPerEvent: 100, maxTotal: 2000 }
    );

    if (entriesArray.length === 0) {
        const emptyNode = document.createElement('li');
        emptyNode.className = 'no-events';
        emptyNode.textContent = holidayItems.length > 0 ? 'No calendar events for this holiday.' : 'No entries for this day.';
        listContainer.appendChild(emptyNode);
        return;
    }

    entriesArray.sort((first, second) => {
        if (first.startDate !== second.startDate) return first.startDate.localeCompare(second.startDate);
        return (first.time || '00:00').localeCompare(second.time || '00:00');
    });

    entriesArray.forEach(item => {
        const li = document.createElement('li');
        li.className = `event-item cat-${item.category || 'personal'}`;

        const timeHTML = item.time ? `<span class="time-badge">🕒 ${escapeHTML(item.time)}</span>` : '';
        let durationHTML = '';
        if (item.startDate !== item.endDate) {
            durationHTML = `<span class="time-badge" style="background:rgba(0,0,0,0.04); font-size:0.7rem;">📅 ${escapeHTML(formatHumanDate(item.startDate, false))} → ${escapeHTML(formatHumanDate(item.endDate, false))}</span>`;
        }

        const participants = getEventParticipants(item);
        const participantHTML = participants.length > 0
            ? `<span class="participant-tag">with @${participants.map(escapeHTML).join(', @')}</span>`
            : '';

        const isOwner = item.owner === currentUser;
        const ownerBadgeClass = isOwner ? 'own-user' : 'foreign-user';
        const ownerLabelText = isOwner ? 'me' : `@${item.owner || 'unknown'}`;
        const ownerHTML = `<span class="owner-identity-pill ${ownerBadgeClass}">👑 ${escapeHTML(ownerLabelText)}</span>`;
        const mentionBadgeHTML = participants.includes(currentUser)
            ? '<span class="owner-identity-pill foreign-user" style="background:var(--accent-dark); color:#fff;">🏷️ Mentioned You</span>'
            : '';

        const recurrenceDescription = item.isRecurringOccurrence ? describeRecurrence(item) : '';
        const recurrenceHTML = recurrenceDescription
            ? `<span class="recurrence-badge" title="${escapeHTML(recurrenceDescription)}">🔁 ${escapeHTML(recurrenceDescription)}</span>`
            : '';
        const recurrenceLineBreak = recurrenceHTML ? '<br class="recurrence-line-break">' : '';

        li.innerHTML = `
            <div class="event-item-main">
                ${timeHTML} ${durationHTML}
                <strong style="display:block; margin-top:2px;">${escapeHTML(item.title)}</strong>
                ${recurrenceHTML}${recurrenceLineBreak}
                ${participantHTML} ${ownerHTML} ${mentionBadgeHTML}
            </div>
            ${buildEventActionControlsHTML(item)}
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

    const searchInput = document.getElementById('incomingSearchInput');
    const filterQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';
    const referenceClock = new Date();
    const boundaryTodayString = formatDateString(referenceClock.getFullYear(), referenceClock.getMonth(), referenceClock.getDate());
    const horizonDate = addYearsClampedToDateString(boundaryTodayString, 120);
    const flattenedIncomingNodes = [];

    Object.entries(calendarEvents).forEach(([eventId, eventObject]) => {
        const recurrenceDescription = describeRecurrence(eventObject);
        const searchableText = [
            eventObject.title || '',
            eventObject.participant || '',
            eventObject.owner || '',
            recurrenceDescription
        ].join(' ').toLowerCase();

        if (filterQuery && !searchableText.includes(filterQuery)) return;

        const nextOccurrences = expandEventOccurrences(
            eventId,
            eventObject,
            boundaryTodayString,
            horizonDate,
            { maxResults: 1 }
        );
        if (nextOccurrences.length > 0) flattenedIncomingNodes.push(nextOccurrences[0]);
    });

    flattenedIncomingNodes.sort((first, second) => {
        if (first.startDate !== second.startDate) return first.startDate.localeCompare(second.startDate);
        return (first.time || '00:00').localeCompare(second.time || '00:00');
    });

    if (flattenedIncomingNodes.length === 0) {
        pipelineContainer.innerHTML = '<li class="no-events">No matching incoming plans discovered.</li>';
        return;
    }

    flattenedIncomingNodes.forEach(item => {
        const li = document.createElement('li');
        li.className = `event-item cat-${item.category || 'personal'}`;

        const dateBadgeHTML = item.startDate === item.endDate
            ? `<span class="time-badge incoming-date-badge">${escapeHTML(formatHumanDate(item.startDate, false))}</span>`
            : `<span class="time-badge incoming-date-badge range">${escapeHTML(formatHumanDate(item.startDate, false))} - ${escapeHTML(formatHumanDate(item.endDate, false))}</span>`;

        const timeHTML = item.time ? `<span class="time-badge">${escapeHTML(item.time)}</span>` : '';
        const participants = getEventParticipants(item);
        const participantHTML = participants.length > 0
            ? `<span class="participant-tag">with @${participants.map(escapeHTML).join(', @')}</span>`
            : '';

        const isOwner = item.owner === currentUser;
        const ownerBadgeClass = isOwner ? 'own-user' : 'foreign-user';
        const ownerLabelText = isOwner ? 'me' : `@${item.owner || 'unknown'}`;
        const ownerHTML = `<span class="owner-identity-pill ${ownerBadgeClass}">👑 ${escapeHTML(ownerLabelText)}</span>`;
        const mentionBadgeHTML = participants.includes(currentUser)
            ? '<span class="owner-identity-pill foreign-user" style="background:var(--accent-dark); color:#fff;">🏷️ Mentioned You</span>'
            : '';

        const recurrenceDescription = item.isRecurringOccurrence ? describeRecurrence(item) : '';
        const recurrenceHTML = recurrenceDescription
            ? `<span class="recurrence-badge" title="${escapeHTML(recurrenceDescription)}">🔁 ${escapeHTML(recurrenceDescription)}</span>`
            : '';
        const recurrenceLineBreak = recurrenceHTML ? '<br class="recurrence-line-break">' : '';

        li.innerHTML = `
            <div class="event-item-main">
                ${dateBadgeHTML} ${timeHTML}
                <strong style="display:block; margin-top:2px;">${escapeHTML(item.title)}</strong>
                ${recurrenceHTML}${recurrenceLineBreak}
                ${participantHTML} ${ownerHTML} ${mentionBadgeHTML}
            </div>
            ${buildEventActionControlsHTML(item)}
        `;
        pipelineContainer.appendChild(li);
    });
}

function handleFormSubmission() {
    if (activeEditingNode.eventId) { processEventMutationUpdate(); } else { addNewEvent(); }
}

function addNewEvent() {
    const payload = buildEventPayloadFromForm(currentUser);
    if (!payload) return;

    const now = Date.now();
    payload.createdAt = now;
    payload.updatedAt = now;
    const eventId = database?.ref('shared_events_v3').push().key || generateLocalKey('event');

    saveEventRecord(
        eventId,
        payload,
        isRecurringEvent(payload) ? 'Recurring event series added' : 'Event added'
    ).then(saved => {
        if (saved) resetFormMutatorState();
    });
}

function initiateInlineEdit(eventId) {
    const targetObject = calendarEvents[eventId];
    if (!targetObject) return;
    if (targetObject.owner !== currentUser) {
        alert('Only the event owner can edit this event.');
        return;
    }

    activeEditingNode = { eventId };

    document.getElementById('newEventInput').value = targetObject.title || '';
    document.getElementById('newEventStartDate').value = targetObject.startDate;
    document.getElementById('newEventEndDate').value = targetObject.endDate || targetObject.startDate;
    document.getElementById('newEventTime').value = targetObject.time || '';
    document.getElementById('newEventCategory').value = targetObject.category || 'personal';

    const participantInput = document.getElementById('newEventParticipant');
    participantInput.value = targetObject.participant || '';

    const participantArray = getEventParticipants(targetObject);
    document.querySelectorAll('#participantCheckboxes .ourcalendar-checkbox').forEach(checkbox => {
        checkbox.checked = participantArray.includes(checkbox.value);
        toggleCheckboxStyle(checkbox);
    });
    updateParticipantField();

    setRecurrenceFormFromEvent(targetObject);
    const helperText = document.getElementById('recurrenceHelperText');
    if (helperText) {
        helperText.textContent = isRecurringEvent(targetObject)
            ? 'You are editing the whole recurring series. All occurrences will be updated.'
            : 'Choose a repeat option to convert this event into a recurring series.';
    }

    const submitButton = document.getElementById('submitActionBtn');
    submitButton.innerText = 'Update';
    submitButton.classList.add('editing-mode');

    document.getElementById('cancelActionBtn').classList.remove('hidden');
    document.getElementById('newEventInput').focus();
    document.getElementById('recurrencePanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function processEventMutationUpdate() {
    const { eventId } = activeEditingNode;
    if (!eventId) return;

    const targetObject = calendarEvents[eventId];
    if (!targetObject || targetObject.owner !== currentUser) {
        alert('This event can no longer be edited by the current user.');
        resetFormMutatorState();
        return;
    }

    const updatedPayload = buildEventPayloadFromForm(targetObject.owner);
    if (!updatedPayload) return;
    updatedPayload.createdAt = targetObject.createdAt || Date.now();
    updatedPayload.updatedAt = Date.now();

    saveEventRecord(
        eventId,
        updatedPayload,
        isRecurringEvent(updatedPayload) ? 'Recurring series updated successfully' : 'Event updated successfully'
    ).then(saved => {
        if (saved) resetFormMutatorState();
    });
}

function resetFormMutatorState() {
    activeEditingNode = { eventId: null };
    document.getElementById('newEventInput').value = '';
    document.getElementById('newEventParticipant').value = '';
    document.getElementById('newEventTime').value = '';
    document.getElementById('newEventCategory').value = 'personal';

    const selectAll = document.getElementById('selectAllOurCalendars');
    if (selectAll) {
        selectAll.checked = false;
        toggleCheckboxStyle(selectAll);
    }

    document.querySelectorAll('#participantCheckboxes .ourcalendar-checkbox').forEach(checkbox => {
        checkbox.checked = false;
        toggleCheckboxStyle(checkbox);
    });

    const dateStr = formatDateString(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
    document.getElementById('newEventStartDate').value = dateStr;
    document.getElementById('newEventEndDate').value = dateStr;
    resetRecurrenceForm();
    handleStartDateChange();

    const helperText = document.getElementById('recurrenceHelperText');
    if (helperText) helperText.textContent = 'Editing or deleting a recurring event affects the whole series.';

    const submitButton = document.getElementById('submitActionBtn');
    submitButton.innerText = 'Add';
    submitButton.classList.remove('editing-mode');
    document.getElementById('cancelActionBtn').classList.add('hidden');
}

function deleteEvent(eventId) {
    const targetObject = calendarEvents[eventId];
    if (!targetObject) return;
    if (targetObject.owner !== currentUser) {
        alert('Only the event owner can delete this event.');
        return;
    }

    const recurring = isRecurringEvent(targetObject);
    const confirmationMessage = recurring
        ? `Delete the recurring series "${targetObject.title}" and every occurrence? Comments and attachments will also be removed.`
        : `Delete the event "${targetObject.title}"? Comments and attachments will also be removed.`;
    if (!confirm(confirmationMessage)) return;

    const previousCollaborationCache = collaborationCache[eventId];
    delete calendarEvents[eventId];
    delete collaborationCache[eventId];
    writeLocalJSON(STORAGE_KEYS.collaboration, collaborationCache);
    persistCalendarCache();
    if (activeDetailEventId === eventId) closeEventDetails();
    if (activeEditingNode.eventId === eventId) resetFormMutatorState();
    refreshAllCalendarViews();

    const eventPath = `shared_events_v3/${eventId}`;
    const collaborationPath = `event_collaboration_v1/${eventId}`;

    if (!database || !isBrowserOnline()) {
        queueOfflineOperation(eventPath, null, `Delete event: ${targetObject.title}`);
        queueOfflineOperation(collaborationPath, null, `Delete event collaboration: ${targetObject.title}`);
        triggerToastAlert('Deleted offline — synchronization pending');
        return;
    }

    const updates = {};
    updates[eventPath] = null;
    updates[collaborationPath] = null;
    database.ref().update(updates).then(() => {
        triggerToastAlert(recurring ? 'Recurring series deleted' : 'Event deleted');
    }).catch(error => {
        if (isLikelyNetworkError(error)) {
            queueOfflineOperation(eventPath, null, `Delete event: ${targetObject.title}`);
            queueOfflineOperation(collaborationPath, null, `Delete event collaboration: ${targetObject.title}`);
            triggerToastAlert('Deleted offline — synchronization pending');
            return;
        }
        calendarEvents[eventId] = targetObject;
        if (previousCollaborationCache) collaborationCache[eventId] = previousCollaborationCache;
        writeLocalJSON(STORAGE_KEYS.collaboration, collaborationCache);
        persistCalendarCache();
        refreshAllCalendarViews();
        console.error('Unable to delete event.', error);
        alert('Unable to delete the event. Please check the database permissions.');
    });
}

// ----------------------------------------------------
// Event comments and attachments v5.0
// ----------------------------------------------------

function normalizeCollaborationData(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        comments: source.comments && typeof source.comments === 'object' ? source.comments : {},
        attachments: source.attachments && typeof source.attachments === 'object' ? source.attachments : {}
    };
}

function formatActivityTimestamp(timestamp) {
    const date = new Date(Number(timestamp || 0));
    if (Number.isNaN(date.getTime())) return 'Unknown time';
    return date.toLocaleString([], {
        day: 'numeric',
        month: 'short',
        year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function persistCollaborationCache(eventId, collaborationData) {
    const normalized = normalizeCollaborationData(collaborationData);
    const cachedAttachments = {};
    Object.entries(normalized.attachments).forEach(([attachmentId, attachment]) => {
        if (!attachment || typeof attachment !== 'object') return;
        cachedAttachments[attachmentId] = attachment.kind === 'file'
            ? { ...attachment, dataUrl: null, offlineUnavailable: true }
            : { ...attachment };
    });

    collaborationCache[eventId] = {
        comments: normalized.comments,
        attachments: cachedAttachments,
        cachedAt: Date.now()
    };
    writeLocalJSON(STORAGE_KEYS.collaboration, collaborationCache);
}

function renderEventDetailSummary(eventObject, occurrenceDate = '') {
    const container = document.getElementById('eventDetailSummary');
    const title = document.getElementById('eventDetailTitle');
    if (!container || !title || !eventObject) return;

    title.textContent = eventObject.title || 'Untitled event';
    const participants = getEventParticipants(eventObject);
    const recurringText = describeRecurrence(eventObject);
    const displayStart = occurrenceDate || eventObject.startDate;
    const durationDays = getEventDurationDays(eventObject);
    const displayEnd = durationDays > 0 ? addDaysToDateString(displayStart, durationDays) : displayStart;
    const dateText = displayStart === displayEnd
        ? formatHumanDate(displayStart, true)
        : `${formatHumanDate(displayStart, true)} → ${formatHumanDate(displayEnd, true)}`;

    container.innerHTML = `
        <div class="detail-summary-grid">
            <div><small>Date</small><strong>📅 ${escapeHTML(dateText)}</strong></div>
            <div><small>Time</small><strong>🕒 ${escapeHTML(eventObject.time || 'All day')}</strong></div>
            <div><small>Owner</small><strong>👤 @${escapeHTML(eventObject.owner || 'unknown')}</strong></div>
            <div><small>Category</small><strong>${escapeHTML(String(eventObject.category || 'personal'))}</strong></div>
        </div>
        ${participants.length ? `<p class="detail-participants"><b>With:</b> @${participants.map(escapeHTML).join(', @')}</p>` : ''}
        ${recurringText ? `<p class="detail-series-note">🔁 Comments and attachments apply to the full series: ${escapeHTML(recurringText)}</p>` : ''}`;
}

function openEventDetails(eventId, occurrenceDate = '') {
    const eventObject = calendarEvents[eventId];
    if (!eventObject) {
        alert('This event is no longer available.');
        return;
    }

    if (collaborationListenerRef) {
        collaborationListenerRef.off();
        collaborationListenerRef = null;
    }

    activeDetailEventId = eventId;
    activeDetailOccurrenceDate = occurrenceDate || eventObject.startDate || '';
    activeCollaborationData = normalizeCollaborationData(collaborationCache[eventId]);
    renderEventDetailSummary(eventObject, activeDetailOccurrenceDate);
    renderEventComments();
    renderEventAttachments();

    const modal = document.getElementById('eventDetailModal');
    modal?.classList.remove('hidden');
    document.body.classList.add('modal-open');
    document.getElementById('eventCommentInput').value = '';
    document.getElementById('eventAttachmentLink').value = '';
    document.getElementById('eventAttachmentFile').value = '';

    if (!database || !isBrowserOnline()) {
        if (!collaborationCache[eventId]) {
            document.getElementById('eventCommentsList').innerHTML = '<div class="collaboration-empty">Comments are unavailable until the calendar reconnects.</div>';
            document.getElementById('eventAttachmentsList').innerHTML = '<div class="collaboration-empty">Attachments are unavailable until the calendar reconnects.</div>';
        }
        return;
    }

    collaborationListenerRef = database.ref(`event_collaboration_v1/${eventId}`);
    collaborationListenerRef.on('value', snapshot => {
        if (activeDetailEventId !== eventId) return;
        activeCollaborationData = normalizeCollaborationData(snapshot.val());
        persistCollaborationCache(eventId, activeCollaborationData);
        renderEventComments();
        renderEventAttachments();
    }, error => {
        console.warn('Unable to load event collaboration.', error);
        triggerToastAlert('Comments and attachments could not be loaded');
    });
}

function closeEventDetails() {
    if (collaborationListenerRef) {
        collaborationListenerRef.off();
        collaborationListenerRef = null;
    }
    document.getElementById('eventDetailModal')?.classList.add('hidden');
    activeDetailEventId = null;
    activeDetailOccurrenceDate = '';
    activeCollaborationData = { comments: {}, attachments: {} };
    if (document.getElementById('pwaHelpModal')?.classList.contains('hidden')) document.body.classList.remove('modal-open');
}

function renderEventComments() {
    const container = document.getElementById('eventCommentsList');
    const countBadge = document.getElementById('eventCommentCount');
    if (!container || !countBadge) return;

    const comments = Object.entries(activeCollaborationData.comments || {})
        .filter(([, comment]) => comment && typeof comment === 'object')
        .sort(([, first], [, second]) => Number(first.createdAt || 0) - Number(second.createdAt || 0));

    countBadge.textContent = String(comments.length);
    container.innerHTML = '';
    if (comments.length === 0) {
        container.innerHTML = '<div class="collaboration-empty">No comments yet. Start the conversation.</div>';
        return;
    }

    comments.forEach(([commentId, comment]) => {
        const commentNode = document.createElement('article');
        commentNode.className = 'comment-item';

        const heading = document.createElement('div');
        heading.className = 'comment-meta-row';
        const author = document.createElement('strong');
        author.textContent = `@${comment.author || 'unknown'}`;
        const timestamp = document.createElement('time');
        timestamp.textContent = formatActivityTimestamp(comment.createdAt);
        heading.append(author, timestamp);

        const message = document.createElement('p');
        message.textContent = String(comment.message || '');
        commentNode.append(heading, message);

        const eventOwner = calendarEvents[activeDetailEventId]?.owner;
        if (comment.author === currentUser || eventOwner === currentUser) {
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'collaboration-delete-button';
            deleteButton.textContent = 'Delete';
            deleteButton.onclick = () => deleteEventComment(commentId);
            commentNode.appendChild(deleteButton);
        }
        container.appendChild(commentNode);
    });
    container.scrollTop = container.scrollHeight;
}

async function addEventComment() {
    if (!activeDetailEventId || !currentUser) return;
    const input = document.getElementById('eventCommentInput');
    const message = input.value.trim();
    if (!message) {
        input.focus();
        return;
    }

    const commentId = database?.ref(`event_collaboration_v1/${activeDetailEventId}/comments`).push().key || generateLocalKey('comment');
    const comment = { message: message.slice(0, 1000), author: currentUser, createdAt: Date.now() };
    activeCollaborationData.comments[commentId] = comment;
    persistCollaborationCache(activeDetailEventId, activeCollaborationData);
    renderEventComments();
    input.value = '';

    const button = document.getElementById('addCommentButton');
    button.disabled = true;
    try {
        const result = await writePathWithOfflineSupport(
            `event_collaboration_v1/${activeDetailEventId}/comments/${commentId}`,
            comment,
            { description: `Comment on event ${activeDetailEventId}` }
        );
        triggerToastAlert(result.queued ? 'Comment saved offline — synchronization pending' : 'Comment posted');
    } catch (error) {
        delete activeCollaborationData.comments[commentId];
        persistCollaborationCache(activeDetailEventId, activeCollaborationData);
        renderEventComments();
        console.error('Unable to post comment.', error);
        alert('Unable to post the comment. Please check the database permissions.');
    } finally {
        button.disabled = false;
    }
}

async function deleteEventComment(commentId) {
    if (!activeDetailEventId || !activeCollaborationData.comments[commentId]) return;
    const comment = activeCollaborationData.comments[commentId];
    const eventOwner = calendarEvents[activeDetailEventId]?.owner;
    if (comment.author !== currentUser && eventOwner !== currentUser) return;

    delete activeCollaborationData.comments[commentId];
    persistCollaborationCache(activeDetailEventId, activeCollaborationData);
    renderEventComments();

    try {
        const result = await writePathWithOfflineSupport(
            `event_collaboration_v1/${activeDetailEventId}/comments/${commentId}`,
            null,
            { description: `Delete comment from event ${activeDetailEventId}` }
        );
        triggerToastAlert(result.queued ? 'Comment deletion queued' : 'Comment deleted');
    } catch (error) {
        activeCollaborationData.comments[commentId] = comment;
        persistCollaborationCache(activeDetailEventId, activeCollaborationData);
        renderEventComments();
        alert('Unable to delete the comment.');
    }
}

function getAttachmentIcon(attachment) {
    if (attachment.kind === 'link') return '🔗';
    const mimeType = String(attachment.mime || '');
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.includes('pdf')) return '📕';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return '📊';
    if (mimeType.includes('word') || mimeType.includes('document')) return '📄';
    return '📎';
}

function formatFileSize(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function renderEventAttachments() {
    const container = document.getElementById('eventAttachmentsList');
    const countBadge = document.getElementById('eventAttachmentCount');
    if (!container || !countBadge) return;

    const attachments = Object.entries(activeCollaborationData.attachments || {})
        .filter(([, attachment]) => attachment && typeof attachment === 'object')
        .sort(([, first], [, second]) => Number(second.createdAt || 0) - Number(first.createdAt || 0));

    countBadge.textContent = String(attachments.length);
    container.innerHTML = '';
    if (attachments.length === 0) {
        container.innerHTML = '<div class="collaboration-empty">No attachments have been added.</div>';
        return;
    }

    attachments.forEach(([attachmentId, attachment]) => {
        const item = document.createElement('article');
        item.className = 'attachment-item';

        if (attachment.kind === 'file' && String(attachment.mime || '').startsWith('image/') && attachment.dataUrl) {
            const preview = document.createElement('img');
            preview.className = 'attachment-image-preview';
            preview.src = attachment.dataUrl;
            preview.alt = '';
            item.appendChild(preview);
        } else {
            const icon = document.createElement('div');
            icon.className = 'attachment-icon';
            icon.textContent = getAttachmentIcon(attachment);
            item.appendChild(icon);
        }

        const detail = document.createElement('div');
        detail.className = 'attachment-detail';
        const name = document.createElement('strong');
        name.textContent = attachment.name || (attachment.kind === 'link' ? 'Web link' : 'Attachment');
        const meta = document.createElement('small');
        const sizeText = attachment.kind === 'file' ? formatFileSize(attachment.size) : 'Web link';
        meta.textContent = `${sizeText}${sizeText ? ' · ' : ''}@${attachment.uploadedBy || 'unknown'} · ${formatActivityTimestamp(attachment.createdAt)}`;
        detail.append(name, meta);
        item.appendChild(detail);

        const actions = document.createElement('div');
        actions.className = 'attachment-actions';
        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.textContent = attachment.offlineUnavailable && !attachment.dataUrl ? 'Online only' : (attachment.kind === 'link' ? 'Open' : 'Download');
        openButton.disabled = Boolean(attachment.offlineUnavailable && !attachment.dataUrl);
        openButton.onclick = () => openEventAttachment(attachmentId);
        actions.appendChild(openButton);

        const eventOwner = calendarEvents[activeDetailEventId]?.owner;
        if (attachment.uploadedBy === currentUser || eventOwner === currentUser) {
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'danger';
            deleteButton.textContent = 'Delete';
            deleteButton.onclick = () => deleteEventAttachment(attachmentId);
            actions.appendChild(deleteButton);
        }
        item.appendChild(actions);
        container.appendChild(item);
    });
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Unable to read file'));
        reader.readAsDataURL(file);
    });
}

async function uploadEventAttachment() {
    if (!activeDetailEventId || !currentUser) return;
    if (!database || !isBrowserOnline()) {
        alert('File uploads require an internet connection. Links and comments can still be queued offline.');
        return;
    }

    const input = document.getElementById('eventAttachmentFile');
    const file = input.files && input.files[0];
    if (!file) {
        alert('Choose a file first.');
        return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
        alert('The selected file is larger than 2 MB. Add a cloud-storage link for larger files.');
        return;
    }
    if (Object.keys(activeCollaborationData.attachments || {}).length >= MAX_ATTACHMENTS_PER_EVENT) {
        alert(`An event can contain up to ${MAX_ATTACHMENTS_PER_EVENT} attachments.`);
        return;
    }

    const button = document.getElementById('uploadAttachmentButton');
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Uploading…';

    try {
        const dataUrl = await readFileAsDataUrl(file);
        const attachmentId = database.ref(`event_collaboration_v1/${activeDetailEventId}/attachments`).push().key;
        const attachment = {
            kind: 'file',
            name: file.name.slice(0, 180),
            mime: file.type || 'application/octet-stream',
            size: file.size,
            dataUrl,
            uploadedBy: currentUser,
            createdAt: Date.now()
        };
        await writePathWithOfflineSupport(
            `event_collaboration_v1/${activeDetailEventId}/attachments/${attachmentId}`,
            attachment,
            { allowOffline: false }
        );
        activeCollaborationData.attachments[attachmentId] = attachment;
        persistCollaborationCache(activeDetailEventId, activeCollaborationData);
        renderEventAttachments();
        input.value = '';
        triggerToastAlert('Attachment uploaded');
    } catch (error) {
        console.error('Unable to upload attachment.', error);
        alert('Unable to upload the file. Check the database permission and available storage.');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

async function addEventLinkAttachment() {
    if (!activeDetailEventId || !currentUser) return;
    const input = document.getElementById('eventAttachmentLink');
    const rawValue = input.value.trim();
    if (!rawValue) {
        input.focus();
        return;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(rawValue);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported protocol');
    } catch (error) {
        alert('Enter a valid http:// or https:// link.');
        return;
    }

    if (Object.keys(activeCollaborationData.attachments || {}).length >= MAX_ATTACHMENTS_PER_EVENT) {
        alert(`An event can contain up to ${MAX_ATTACHMENTS_PER_EVENT} attachments.`);
        return;
    }

    const attachmentId = database?.ref(`event_collaboration_v1/${activeDetailEventId}/attachments`).push().key || generateLocalKey('link');
    const attachment = {
        kind: 'link',
        name: parsedUrl.hostname.replace(/^www\./, '') || 'Web link',
        url: parsedUrl.href,
        uploadedBy: currentUser,
        createdAt: Date.now()
    };
    activeCollaborationData.attachments[attachmentId] = attachment;
    persistCollaborationCache(activeDetailEventId, activeCollaborationData);
    renderEventAttachments();
    input.value = '';

    try {
        const result = await writePathWithOfflineSupport(
            `event_collaboration_v1/${activeDetailEventId}/attachments/${attachmentId}`,
            attachment,
            { description: `Link attachment on event ${activeDetailEventId}` }
        );
        triggerToastAlert(result.queued ? 'Link saved offline — synchronization pending' : 'Link attached');
    } catch (error) {
        delete activeCollaborationData.attachments[attachmentId];
        persistCollaborationCache(activeDetailEventId, activeCollaborationData);
        renderEventAttachments();
        alert('Unable to attach the link.');
    }
}

function openEventAttachment(attachmentId) {
    const attachment = activeCollaborationData.attachments?.[attachmentId];
    if (!attachment) return;

    if (attachment.kind === 'link') {
        const openedWindow = window.open(attachment.url, '_blank', 'noopener,noreferrer');
        if (openedWindow) openedWindow.opener = null;
        return;
    }

    if (!attachment.dataUrl) {
        alert('This file is not stored in the offline cache. Reconnect and reopen the event.');
        return;
    }

    const downloadLink = document.createElement('a');
    downloadLink.href = attachment.dataUrl;
    downloadLink.download = attachment.name || 'attachment';
    downloadLink.rel = 'noopener';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
}

async function deleteEventAttachment(attachmentId) {
    if (!activeDetailEventId || !activeCollaborationData.attachments[attachmentId]) return;
    const attachment = activeCollaborationData.attachments[attachmentId];
    const eventOwner = calendarEvents[activeDetailEventId]?.owner;
    if (attachment.uploadedBy !== currentUser && eventOwner !== currentUser) return;
    if (!confirm(`Delete attachment "${attachment.name || 'Attachment'}"?`)) return;

    delete activeCollaborationData.attachments[attachmentId];
    persistCollaborationCache(activeDetailEventId, activeCollaborationData);
    renderEventAttachments();

    try {
        const result = await writePathWithOfflineSupport(
            `event_collaboration_v1/${activeDetailEventId}/attachments/${attachmentId}`,
            null,
            { description: `Delete attachment from event ${activeDetailEventId}` }
        );
        triggerToastAlert(result.queued ? 'Attachment deletion queued' : 'Attachment deleted');
    } catch (error) {
        activeCollaborationData.attachments[attachmentId] = attachment;
        persistCollaborationCache(activeDetailEventId, activeCollaborationData);
        renderEventAttachments();
        alert('Unable to delete the attachment.');
    }
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
            • <b>Recurring Event:</b> Use the Repeat controls in the event form<br>
            • <b>Delete Single Event:</b> <i>"delete Meeting"</i><br>
            • <b>Complete Wipeout:</b> <i>"clear all my events"</i>`, 'bot');
        return;
    }

    if (cleanText === 'today' || cleanText === 'status' || cleanText === 'schedule') {
        const nowClock = new Date();
        const formatStr = formatDateString(nowClock.getFullYear(), nowClock.getMonth(), nowClock.getDate());
        
        let todaysEvents = getOccurrencesBetween(
            formatStr,
            formatStr,
            eventObject => isEventAssociatedWithUser(eventObject, currentUser),
            { maxPerEvent: 100, maxTotal: 2000 }
        );

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

        let targetedMonthEvents = getOccurrencesBetween(
            firstDateStr,
            lastDateStr,
            eventObject => isEventAssociatedWithUser(eventObject, currentUser),
            { maxPerEvent: 1000, maxTotal: 10000 }
        );

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

            if (eventOccursOnDate(ev, parsedLookupDateStr)) {
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
                if (rangeMatch[2]) { let m = checkMonthInText(rangeMatch[2].toLowerCase()); if (m !== null) startMonth = m; }
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
                eventOccursOnDate(ev, startDateStr) &&
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

        const payload = { title, participant, startDate: startDateStr, endDate: endDateStr, time, category: parsedCategory, owner: currentUser };

        payload.createdAt = Date.now();
        payload.updatedAt = payload.createdAt;
        const eventId = database?.ref('shared_events_v3').push().key || generateLocalKey('event');
        saveEventRecord(eventId, payload, 'Event added by OurCalendarBot');

        currentDate.setMonth(startMonth);
        selectedDate = new Date(currentDate.getFullYear(), startMonth, startDayNum);

        appendMessage(`🚀 Timeline mapped! Added <b>"${title}"</b> from ${startDayNum} ${monthNames[startMonth]} to ${endDayNum} ${monthNames[endMonth]}.${responseWarningHTML}`, 'bot');
        return;
    }

    appendMessage("Unrecognized statement format. Type <code>help</code> to display matching functions.", 'bot');
}

window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    setPwaInstallButtonsVisible(!isRunningStandalone());
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    setPwaInstallButtonsVisible(false);
    triggerToastAlert('OurCalendar installed successfully');
});

window.addEventListener('online', () => {
    updateNetworkStatusIndicator();
    flushOfflineOperations();
    loadHolidaysForVisibleYear(false);
});

window.addEventListener('offline', () => {
    updateNetworkStatusIndicator();
    triggerToastAlert('Offline mode active — cached calendar remains available');
});

window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!document.getElementById('eventDetailModal')?.classList.contains('hidden')) closeEventDetails();
    else if (!document.getElementById('pwaHelpModal')?.classList.contains('hidden')) closePwaHelp();
});
