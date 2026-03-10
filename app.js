// --- CONFIGURATION ---
const CONFIG = {
    IDEMPOTENCY_WINDOW: 1000 * 60 * 5 // 5 Minutes
};

// --- GLOBAL STATE ---
let STATE = {
    view: 'quests',
    habits: [],
    stats: {},
    selectedHabit: null,
    recentLogIds: new Set()
};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    init();
});

async function init() {
    console.log("RPG: Initializing Client...");
    const board = document.getElementById('quest-board');
    board.innerHTML = '<div class="loading">Loading Quests...</div>';

    try {
        const [habits, stats] = await Promise.all([
            fetchHabits(),
            getStats()
        ]);

        if (habits && habits.length > 0) {
            STATE.habits = habits;
            STATE.stats = stats || {};
            
            updateHeroProfile();
            renderGrid(STATE.habits);
        } else {
             board.innerHTML = '<div class="empty-state">No active habits found. Check Studio!</div>';
        }

    } catch (error) {
        console.error("Init Error:", error);
        board.innerHTML = `<div class="error">Connection Failed.<br>Check Console.</div>`;
    }
    
    setupModalListeners();
}

const LocalEngine = {
    /**
     * FIX: Plain today in YYYY-MM-DD. No 4AM offset.
     * The user-selected date from the picker is the source of truth.
     * This helper is only used for "is this log for today?" checks.
     */
    getTodayString: function() {
        return new Date().toLocaleDateString('en-CA'); // Returns YYYY-MM-DD in local timezone
    },

    calculateOptimisticStats: function(currentStats, payload, habit) {
        const stats = { 
            streak: currentStats.streak || 0,
            best_streak: currentStats.best_streak || 0,
            total_xp: Number(currentStats.total_xp) || 0,
            total_volume: Number(currentStats.total_volume) || 0,
            // FIX: Key name now matches server's output
            last_log_date: currentStats.last_log_date || null
        };

        const intensity = Number(payload.intensity) || 1;
        const val = parseFloat(payload.value) || 0;
        
        stats.total_volume += val;
        const earnedXP = val * parseFloat(habit.xp_multi) * intensity;
        stats.total_xp += earnedXP;

        // The date the user picked in the UI
        const logDate = payload.logical_date;
        // Today's actual calendar date (no offset)
        const today = this.getTodayString();

        if (stats.last_log_date) {
            const msPerDay = 1000 * 60 * 60 * 24;
            const d1 = new Date(logDate + "T00:00:00");
            const d2 = new Date(stats.last_log_date + "T00:00:00");
            const diffDays = Math.round((d1 - d2) / msPerDay);

            if (diffDays === 1) {
                stats.streak += 1;           // Next consecutive day
            } else if (diffDays > 1) {
                stats.streak = 1;            // Gap — restart at 1
            }
            // diffDays === 0: Same day re-log — no streak change
            // diffDays < 0: Backdated before last_log — no streak change
        } else {
            stats.streak = 1;                // First ever log
        }

        if (stats.streak > stats.best_streak) stats.best_streak = stats.streak;

        // Only advance last_log_date forward
        if (!stats.last_log_date || logDate >= stats.last_log_date) {
            stats.last_log_date = logDate;
        }

        return { stats, earnedXP };
    },

    isDuplicate: function(id) {
        if (STATE.recentLogIds.has(id)) return true;
        STATE.recentLogIds.add(id);
        setTimeout(() => { STATE.recentLogIds.delete(id); }, CONFIG.IDEMPOTENCY_WINDOW);
        return false;
    }
};

// --- ACTION HANDLERS ---

async function submitLog() {
    const habit = STATE.selectedHabit;
    if (!habit) return;

    const valueInput = document.getElementById('log-value');
    const noteInput = document.getElementById('log-note');
    const dateInput = document.getElementById('log-date');
    const submitBtn = document.querySelector('.btn-submit');
    
    let intensity = 1;
    const intensityInputs = document.getElementsByName('log-intensity');
    for (const radio of intensityInputs) {
        if (radio.checked) { intensity = Number(radio.value); break; }
    }

    const val = valueInput.value;
    if (habit.metric !== 'BOOL' && (!val || val <= 0)) {
        alert("Please enter a valid positive value."); return;
    }

    const logId = crypto.randomUUID();
    if (LocalEngine.isDuplicate(logId)) return;

    const originalBtnText = submitBtn.textContent;
    submitBtn.textContent = "Saving...";
    submitBtn.disabled = true;

    const payload = {
        id: logId,
        logical_date: dateInput.value,    // THE SINGLE SOURCE OF TRUTH
        habit_id: habit.id,
        metric: habit.metric,
        value: val,
        intensity: intensity,
        note: noteInput.value
    };

    try {
        const currentStats = STATE.stats[habit.id] || {};
        const result = LocalEngine.calculateOptimisticStats(currentStats, payload, habit);
        
        STATE.stats[habit.id] = result.stats;
        updateHeroProfile();
        renderGrid(STATE.habits);
        document.getElementById('log-modal').close();
        showToast(`Saved! +${result.earnedXP.toFixed(0)} XP`);

        await postLog(payload);
        
    } catch (err) {
        console.error("Sync Error:", err);
        alert("Saved locally, but failed to sync to server.");
    } finally {
        submitBtn.textContent = originalBtnText;
        submitBtn.disabled = false;
    }
}

// --- UI RENDERERS ---

function updateHeroProfile() {
    let globalXP = 0;
    Object.values(STATE.stats).forEach(stat => {
        globalXP += (Number(stat.total_xp) || 0);
    });

    const globalLevel = Math.floor(Math.sqrt(globalXP / 100)) + 1;
    const nextLevelXP = Math.pow(globalLevel, 2) * 100;
    const levelProgress = ((globalXP - Math.pow(globalLevel - 1, 2) * 100) / (nextLevelXP - Math.pow(globalLevel - 1, 2) * 100)) * 100;

    document.querySelector('.username').textContent = `Player One (Lvl ${globalLevel})`;
    document.querySelector('.level-text').textContent = `${Math.floor(globalXP)} XP / ${nextLevelXP} XP`;
    document.querySelector('.xp-fill').style.width = `${Math.max(5, Math.min(100, levelProgress))}%`;
}

function renderGrid(habits) {
    habits = habits.filter(h => h.active === true);
    const board = document.getElementById('quest-board');
    board.innerHTML = '';

    if (habits.length === 0) {
        board.innerHTML = '<div class="empty-state">No active habits found.</div>';
        return;
    }

    habits.forEach(habit => {
        const stat = STATE.stats[habit.id] || { streak: 0, best_streak: 0, total_xp: 0, total_volume: 0 };
        const card = document.createElement('div');
        card.className = 'quest-card';
        card.style.borderLeft = `5px solid ${habit.color}`;
        
        let icon = "⚡";
        if (habit.metric === "TIME") icon = "⏳";
        if (habit.metric === "MONEY") icon = "💰";
        if (habit.metric === "COUNT") icon = "🔢";

        const isStreakActive = stat.streak > 0;
        
        let displayVolume = stat.total_volume;
        let displayUnit = habit.unit;

        if (displayUnit && (displayUnit.toLowerCase() === 'mins' || displayUnit.toLowerCase() === 'minutes')) {
            displayVolume = (displayVolume / 60).toFixed(1); 
            displayUnit = 'Hrs';
        }

        card.innerHTML = `
            <div class="quest-header">
                <span class="quest-icon">${icon}</span>
                <div class="quest-title-block">
                    <span class="quest-title">${habit.name}</span>
                </div>
            </div>
            <div class="quest-stats">
                <div class="stat-pill ${isStreakActive ? "streak-active" : "streak-dormant"}">
                    ${isStreakActive ? "🔥" : "🌑"} ${stat.streak} 
                    <span class="best-streak"> / ${stat.best_streak}</span>
                </div>
                <div class="stat-pill volume-pill" style="background: ${habit.color}20; color: ${habit.color}">
                    ${displayVolume} ${displayUnit}
                </div>
            </div>
        `;
        card.addEventListener('click', () => openLogModal(habit));
        board.appendChild(card);
    });
}

function openLogModal(habit) {
    STATE.selectedHabit = habit;
    const modal = document.getElementById('log-modal');
    const inputField = document.getElementById('log-value');

    // FIX: Simpler, reliable local date
    const localDate = new Date().toLocaleDateString('en-CA');

    // Reset Fields
    document.getElementById('log-value').value = '';
    document.getElementById('log-note').value = '';
    document.getElementById('log-date').value = localDate;
    document.getElementById('modal-title').textContent = `Log ${habit.name}`;
    document.getElementById('modal-title').style.color = habit.color;

    // Configure Input Type
    const label = document.getElementById('input-label');
    if (habit.metric === 'TIME') { label.textContent = "Duration (minutes)"; inputField.type = "number"; }
    else if (habit.metric === 'MONEY') { label.textContent = "Amount"; inputField.type = "number"; }
    else if (habit.metric === 'COUNT') { label.textContent = "Quantity"; inputField.type = "number"; }
    else { label.textContent = "Completed?"; inputField.type = "hidden"; inputField.value = "1"; }

    // --- DYNAMIC INTENSITY SELECTOR ---
    const intensityContainer = document.getElementById('intensity-group');
    if (!intensityContainer) {
        const newGroup = document.createElement('div');
        newGroup.id = 'intensity-group';
        newGroup.className = 'input-group';
        document.querySelector('.modal-body').insertBefore(newGroup, document.querySelector('.modal-body').lastElementChild); 
    }
    
    const iGroup = document.getElementById('intensity-group');
    if (habit.metric === 'BOOL') {
        iGroup.style.display = 'none';
        iGroup.innerHTML = `<input type="hidden" name="log-intensity" value="1" checked>`;
    } else {
        iGroup.style.display = 'block';
        iGroup.innerHTML = `
            <label>Focus / Intensity</label>
            <div class="intensity-selector">
                <label class="intensity-option">
                    <input type="radio" name="log-intensity" value="0.5">
                    <span>Low (0.5x)</span>
                </label>
                <label class="intensity-option">
                    <input type="radio" name="log-intensity" value="1" checked>
                    <span>Normal (1x)</span>
                </label>
                <label class="intensity-option">
                    <input type="radio" name="log-intensity" value="2">
                    <span>High (2x)</span>
                </label>
            </div>
        `;
    }

    modal.showModal();
}

function setupModalListeners() {
    const logModal = document.getElementById('log-modal');
    document.getElementById('modal-close').addEventListener('click', () => logModal.close());
    logModal.addEventListener('click', (e) => { if (e.target === logModal) logModal.close(); });
    document.getElementById('log-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await submitLog();
    });

    document.getElementById('profile-trigger').addEventListener('click', () => toggleDrawer());
    document.getElementById('drawer-backdrop').addEventListener('click', () => toggleDrawer(true));
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.target));
    });

    const cfgModal = document.getElementById('config-modal');
    document.getElementById('btn-new-habit').addEventListener('click', () => openConfigModal(null));
    document.getElementById('config-close').addEventListener('click', () => cfgModal.close());
    cfgModal.addEventListener('click', (e) => { if (e.target === cfgModal) cfgModal.close(); });
    document.getElementById('config-form').addEventListener('submit', handleConfigSubmit);
}

function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// --- NAVIGATION & DRAWER ---

function toggleDrawer(forceClose = false) {
    const drawer = document.getElementById('app-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    if (forceClose || drawer.classList.contains('open')) {
        drawer.classList.remove('open');
        backdrop.classList.remove('visible');
    } else {
        drawer.classList.add('open');
        backdrop.classList.add('visible');
    }
}

function switchView(viewName) {
    STATE.view = viewName;
    document.getElementById('view-quests').style.display = viewName === 'quests' ? 'block' : 'none';
    document.getElementById('view-studio').style.display = viewName === 'studio' ? 'block' : 'none';
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.target === viewName);
    });
    if (viewName === 'studio') renderStudio(STATE.habits);
    else renderGrid(STATE.habits);
    toggleDrawer(true);
}

// --- STUDIO LOGIC ---

function renderStudio(habits) {
    const list = document.getElementById('studio-habit-list');
    list.innerHTML = '';
    habits.forEach(habit => {
        const item = document.createElement('div');
        item.className = `habit-item ${habit.active ? '' : 'archived'}`;
        const icon = habit.metric === 'TIME' ? '⏳' : habit.metric === 'MONEY' ? '💰' : habit.metric === 'COUNT' ? '🔢' : '⚡';
        item.innerHTML = `
            <div class="habit-info">
                <h4 style="color: ${habit.color}">${icon} ${habit.name}</h4>
                <div class="habit-meta">${habit.active ? 'Active' : 'Archived'} • ${habit.metric} • ${habit.xp_multi}x XP</div>
            </div>
            <div class="habit-edit-icon">✎</div>
        `;
        item.addEventListener('click', () => openConfigModal(habit));
        list.appendChild(item);
    });
}

function updateSuggestions() {
    const uniqueCats = new Set();
    const uniqueSubs = new Set();

    STATE.habits.forEach(h => {
        if (h.category) uniqueCats.add(h.category);
        if (h.sub_category) uniqueSubs.add(h.sub_category);
    });

    let catList = document.getElementById('dl-cats');
    if (!catList) {
        catList = document.createElement('datalist');
        catList.id = 'dl-cats';
        document.body.appendChild(catList);
    }
    catList.innerHTML = '';
    uniqueCats.forEach(c => {
        const option = document.createElement('option');
        option.value = c;
        catList.appendChild(option);
    });

    let subList = document.getElementById('dl-subcats');
    if (!subList) {
        subList = document.createElement('datalist');
        subList.id = 'dl-subcats';
        document.body.appendChild(subList);
    }
    subList.innerHTML = '';
    uniqueSubs.forEach(s => {
        const option = document.createElement('option');
        option.value = s;
        subList.appendChild(option);
    });
}

function openConfigModal(habit = null) {
    updateSuggestions();
    const form = document.getElementById('config-form');
    form.reset();
    
    if (habit) {
        document.getElementById('config-modal-title').textContent = "Edit Habit";
        document.getElementById('cfg-id').value = habit.id;
        document.getElementById('cfg-name').value = habit.name;
        document.getElementById('cfg-cat').value = habit.category;
        document.getElementById('cfg-subcat').value = habit.sub_category || "";
        document.getElementById('cfg-type').value = habit.type || "Habit";
        document.getElementById('cfg-metric').value = habit.metric;
        document.getElementById('cfg-unit').value = habit.unit || "";
        document.getElementById('cfg-xp').value = habit.xp_multi;
        document.getElementById('cfg-color').value = habit.color;
        document.getElementById('cfg-active').checked = habit.active;
    } else {
        document.getElementById('config-modal-title').textContent = "New Habit";
        document.getElementById('cfg-id').value = "";
        document.getElementById('cfg-color').value = "#3b82f6";
        document.getElementById('cfg-type').value = "Habit";
    }
    document.getElementById('config-modal').showModal();
}

async function handleConfigSubmit(e) {
    e.preventDefault();
    const submitBtn = e.target.querySelector('.btn-submit');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = "Saving...";
    submitBtn.disabled = true;

    const habitData = {
        id: document.getElementById('cfg-id').value || null,
        name: document.getElementById('cfg-name').value,
        category: document.getElementById('cfg-cat').value,
        sub_category: document.getElementById('cfg-subcat').value,
        type: document.getElementById('cfg-type').value,
        metric: document.getElementById('cfg-metric').value,
        unit: document.getElementById('cfg-unit').value,
        xp_multi: parseFloat(document.getElementById('cfg-xp').value),
        color: document.getElementById('cfg-color').value,
        active: document.getElementById('cfg-active').checked
    };

    try {
        await saveHabit(habitData);
        STATE.habits = await fetchHabits();
        if (STATE.view === 'studio') renderStudio(STATE.habits);
        else renderGrid(STATE.habits);
        document.getElementById('config-modal').close();
        showToast("Habit Configuration Saved!");
    } catch (error) {
        alert("Failed to save.");
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
}