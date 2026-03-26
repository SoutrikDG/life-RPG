// ============================================================
// LIFE RPG v2.0 — app.js (FIXED)
// ============================================================

const CONFIG = {
    BASE_XP_PER_CATEGORY: 100,
    BOOL_XP_PER_COMPLETION: 10,
    SKILL_XP_DISCOUNT: 0.5,
    CACHE_TTL_MS: 1000 * 60 * 10  // 10 minutes
};

let STATE = {
    view: 'board',
    categories: [],
    habits: [],
    stats: { category_stats: {}, habit_stats: {} },
    selectedCategory: null,
    boolChecked: {},        // { habitId: true } — in-session BOOL toggles
    boolUnchecked: {},      // FIX #5: track in-session un-checks to override server state
    recentLogIds: new Set()
};

// ============================================================
// INIT
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    init();
});

async function init() {
    const cached = loadFromCache();
    if (cached) {
        STATE.categories = cached.categories || [];
        STATE.habits     = cached.habits     || [];
        STATE.stats      = cached.stats      || { category_stats: {}, habit_stats: {} };
        renderAll();
    } else {
        document.getElementById('category-board').innerHTML = '<div class="loading">Connecting to Server...</div>';
    }

    try {
        const [categories, habits, stats] = await Promise.all([
            fetchCategories(),
            fetchHabits(),
            getStats()
        ]);
        STATE.categories = categories || [];
        STATE.habits     = habits     || [];
        STATE.stats      = stats      || { category_stats: {}, habit_stats: {} };
        STATE.boolChecked = {};
        STATE.boolUnchecked = {};
        renderAll();
        saveToCache();
    } catch (err) {
        console.error('Init error:', err);
        if (!STATE.categories.length) {
            document.getElementById('category-board').innerHTML = '<div class="error">Connection failed. Check console.</div>';
        }
    }
}

function renderAll() {
    updateHeroProfile();
    renderBoard();
}

// ============================================================
// HERO PROFILE
// ============================================================

function getRankTitle(level) {
    if (level <= 3)  return 'Apprentice';
    if (level <= 6)  return 'Initiate';
    if (level <= 10) return 'Journeyman';
    if (level <= 15) return 'Adept';
    if (level <= 20) return 'Specialist';
    if (level <= 30) return 'Expert';
    if (level <= 40) return 'Master';
    if (level <= 50) return 'Grandmaster';
    return 'Legend';
}

function updateHeroProfile() {
    // Use raw habit_stats sum as primary XP source
    let totalXP = 0;
    Object.values(STATE.stats.habit_stats || {}).forEach(hs => {
        totalXP += Number(hs.total_xp) || 0;
    });

    const level = Math.floor(Math.sqrt(totalXP / 100)) + 1;
    const thisLevelXP  = Math.pow(level - 1, 2) * 100;
    const nextLevelXP  = Math.pow(level, 2) * 100;
    const progress = nextLevelXP > thisLevelXP
        ? ((totalXP - thisLevelXP) / (nextLevelXP - thisLevelXP)) * 100
        : 100;

    document.querySelector('.username').textContent = `${getRankTitle(level)} (Lvl ${level})`;
    document.querySelector('.level-text').textContent = `${Math.floor(totalXP)} XP / ${nextLevelXP} XP`;
    document.querySelector('.xp-fill').style.width = `${Math.max(3, Math.min(100, progress))}%`;

    // Daily completion summary
    const activeCategories = STATE.categories.filter(c => c.active);
    let done = 0;
    activeCategories.forEach(cat => {
        const cs = STATE.stats.category_stats?.[cat.id] || {};
        if (isCategoryComplete(cat, cs)) done++;
    });

    const summaryEl = document.getElementById('daily-summary');
    if (activeCategories.length === 0) {
        summaryEl.textContent = '—';
        summaryEl.className = 'daily-summary';
    } else if (done === activeCategories.length) {
        summaryEl.textContent = 'All Categories Complete! ✓';
        summaryEl.className = 'daily-summary all-done';
    } else {
        summaryEl.textContent = `${done}/${activeCategories.length} Categories Complete`;
        summaryEl.className = 'daily-summary';
    }
}

function isCategoryComplete(cat, catStats) {
    if (cat.metric_type === 'TIME') {
        return (catStats.today_logged_mins || 0) >= (cat.target_minutes || 1);
    }
    // BOOL
    const contributors = getCategoryHabits(cat.id).filter(h => h.active);
    if (contributors.length === 0) return false;
    const rule = cat.completion_rule || 'ALL';
    const checkedToday = contributors.filter(h => isCheckedToday(h.id));
    if (rule === 'ANY') return checkedToday.length > 0;
    return checkedToday.length === contributors.length;
}

// ============================================================
// BOARD RENDERING
// ============================================================

function renderBoard() {
    const board = document.getElementById('category-board');
    const activeCategories = STATE.categories
        .filter(c => c.active)
        .sort((a, b) => (a.sort_order || 99) - (b.sort_order || 99));

    if (activeCategories.length === 0) {
        board.innerHTML = '<div class="empty-state">No active categories. Set them up in Habit Studio.</div>';
        return;
    }

    board.innerHTML = '';
    activeCategories.forEach(cat => {
        const cs = STATE.stats.category_stats?.[cat.id] || {};
        const catHabits = getCategoryHabits(cat.id).filter(h => h.active);
        const el = cat.metric_type === 'BOOL'
            ? renderBoolTile(cat, cs, catHabits)
            : renderTimeTile(cat, cs, catHabits);
        board.appendChild(el);
    });
}

function renderTimeTile(cat, cs, catHabits) {
    const el = document.createElement('div');
    el.className = 'category-tile';
    el.style.borderTopColor = cat.color || '#3b82f6';
    el.dataset.catId = cat.id;

    const todayMins   = cs.today_logged_mins || 0;
    const target      = cat.target_minutes || 1;
    const threshold   = cat.min_threshold_pct || 60;
    const pct         = Math.min(100, todayMins / target * 100);
    const thresholdMet = pct >= threshold;
    const targetHit    = pct >= 100;

    const fillClass = targetHit ? 'target-hit' : thresholdMet ? 'threshold-met' : 'below-threshold';
    const todayInProgress = pct > 0 && !thresholdMet;

    el.innerHTML = `
        <div class="category-tile-header">
            <div class="tile-icon-name">
                <span class="tile-icon">${cat.icon || '⚡'}</span>
                <span class="tile-name">${cat.name}</span>
            </div>
            ${todTag(cat.time_of_day)}
        </div>

        <div>
            <div class="progress-bar-container">
                <div class="progress-bar-fill ${fillClass}"
                     style="width:${pct}%; background:${cat.color || '#3b82f6'}"></div>
                <div class="progress-threshold-marker"
                     style="left:${threshold}%"></div>
            </div>
            <div class="progress-time-label">
                ${formatTime(todayMins)} / ${formatTime(target)}
            </div>
        </div>

        <div class="category-tile-footer">
            <span class="streak-badge ${(cs.streak || 0) > 0 ? 'active' : 'dormant'}">
                ${(cs.streak || 0) > 0 ? '🔥' : '🌑'} ${cs.streak || 0}
                <span class="best-streak-label">/ ${cs.best_streak || 0}</span>
            </span>
            ${renderHeatStrip(cs.last_7_days || [], cat.color || '#3b82f6', todayInProgress)}
            <button class="tile-expand-toggle" data-cat="${cat.id}" type="button">▾</button>
        </div>

        <div class="tile-expand-area" id="expand-${cat.id}">
            ${buildContributorBreakdown(catHabits, cs)}
        </div>
    `;

    // Tap tile body → open log sheet (but not expand button)
    el.addEventListener('click', e => {
        if (e.target.closest('.tile-expand-toggle')) return;
        openLogSheet(cat);
    });

    el.querySelector('.tile-expand-toggle').addEventListener('click', e => {
        e.stopPropagation();
        const area = el.querySelector('.tile-expand-area');
        const btn  = el.querySelector('.tile-expand-toggle');
        area.classList.toggle('open');
        btn.classList.toggle('open');
    });

    return el;
}

function renderBoolTile(cat, cs, catHabits) {
    const el = document.createElement('div');
    el.className = 'category-tile';
    el.style.borderTopColor = cat.color || '#3b82f6';
    el.style.cursor = 'default';
    el.dataset.catId = cat.id;

    const total   = catHabits.length;
    const checked = catHabits.filter(h => isCheckedToday(h.id)).length;
    const allDone = total > 0 && checked === total;

    const checklistHTML = catHabits.map(h => {
        const done = isCheckedToday(h.id);
        return `
            <div class="bool-item ${done ? 'checked' : ''}" data-habit="${h.id}" data-cat="${cat.id}">
                <div class="bool-item-check">${done ? '✓' : ''}</div>
                <span class="bool-item-name">${h.name}</span>
            </div>
        `;
    }).join('');

    el.innerHTML = `
        <div class="category-tile-header">
            <div class="tile-icon-name">
                <span class="tile-icon">${cat.icon || '⚡'}</span>
                <span class="tile-name">${cat.name}</span>
            </div>
            ${allDone ? '<span style="color:#4ade80;font-size:0.9rem;">✓</span>' : ''}
        </div>

        <div class="bool-checklist">${checklistHTML}</div>

        <div class="bool-completion-count ${allDone ? 'done' : ''}">
            ${allDone ? `${total}/${total} complete` : `${checked}/${total} done`}
        </div>

        <div class="category-tile-footer">
            <span class="streak-badge ${(cs.streak || 0) > 0 ? 'active' : 'dormant'}">
                ${(cs.streak || 0) > 0 ? '🔥' : '🌑'} ${cs.streak || 0}
                <span class="best-streak-label">/ ${cs.best_streak || 0}</span>
            </span>
            ${renderHeatStrip(cs.last_7_days || [], cat.color || '#3b82f6', false)}
        </div>
    `;

    el.querySelectorAll('.bool-item').forEach(item => {
        item.addEventListener('click', () => {
            toggleBoolContributor(item.dataset.habit, item.dataset.cat);
        });
    });

    // FIX #2: Long-press or dedicated button for backdated BOOL logging
    // We add a small "📅" date button that opens a date-pick modal
    const dateBtn = document.createElement('button');
    dateBtn.className = 'tile-expand-toggle';
    dateBtn.type = 'button';
    dateBtn.textContent = '📅';
    dateBtn.title = 'Log for a past date';
    dateBtn.style.fontSize = '0.8rem';
    dateBtn.addEventListener('click', e => {
        e.stopPropagation();
        openBoolDateModal(cat, catHabits);
    });
    el.querySelector('.category-tile-footer').appendChild(dateBtn);

    return el;
}

function renderHeatStrip(last7Days, color, todayInProgress) {
    if (!last7Days || last7Days.length === 0) {
        return `<div class="heat-strip">${Array(7).fill('<div class="heat-day"></div>').join('')}</div>`;
    }
    const squares = last7Days.map((d, i) => {
        const isToday = i === last7Days.length - 1;
        const inProgress = isToday && todayInProgress;
        const cls = [
            'heat-day',
            d.met ? 'met' : 'missed',
            isToday ? 'today' : '',
            inProgress ? 'in-progress' : ''
        ].filter(Boolean).join(' ');
        const bg = d.met ? `background:${color};` : '';
        return `<div class="${cls}" style="${bg}"></div>`;
    }).join('');
    return `<div class="heat-strip">${squares}</div>`;
}

function buildContributorBreakdown(habits, cs) {
    const contributors = cs.today_contributors || {};
    if (!habits.length || !Object.keys(contributors).length) return 'No logs today yet.';
    const total = habits.reduce((sum, h) => sum + (contributors[h.id]?.primary || 0), 0);
    if (total === 0) return 'No logs today yet.';
    return habits
        .filter(h => contributors[h.id]?.primary > 0)
        .map(h => {
            const pct = Math.round((contributors[h.id].primary / total) * 100);
            return `${h.name} ${pct}%`;
        })
        .join(' · ') || 'No logs today yet.';
}

function todTag(timeOfDay) {
    if (!timeOfDay || timeOfDay === 'ANYTIME') return '';
    const labels = { MORNING: '☀ Morn', AFTERNOON: '🌤 Aft', EVENING: '🌙 Eve' };
    return `<span class="tile-tod-tag">${labels[timeOfDay] || ''}</span>`;
}

// ============================================================
// BOTTOM SHEET (TIME logging)
// ============================================================

function openLogSheet(cat) {
    STATE.selectedCategory = cat;
    const catHabits = getCategoryHabits(cat.id).filter(h => h.active);
    if (!catHabits.length) { showToast('No active contributors in this category.'); return; }

    document.getElementById('sheet-title').textContent = `Log ${cat.name}`;

    // Populate contributor dropdown
    const select = document.getElementById('sheet-contributor');
    select.innerHTML = '';
    catHabits.forEach(h => {
        const opt = document.createElement('option');
        opt.value = h.id;
        opt.textContent = h.name;
        select.appendChild(opt);
    });

    // Restore last-used contributor
    const lastUsed = localStorage.getItem(`lastContributor_${cat.id}`);
    if (lastUsed && catHabits.find(h => h.id === lastUsed)) {
        select.value = lastUsed;
    }

    // Date
    document.getElementById('sheet-date').value = getToday();

    // Reset note + submit button
    const noteInput = document.getElementById('sheet-note');
    noteInput.value = '';
    document.getElementById('sheet-submit').disabled = true;

    // Apply defaults for selected contributor
    applyContributorDefaults();

    // Open sheet
    document.getElementById('log-sheet').classList.add('open');
    document.getElementById('sheet-backdrop').classList.add('visible');

    // Focus value after animation
    setTimeout(() => document.getElementById('sheet-value').focus(), 350);
}

function applyContributorDefaults() {
    const select = document.getElementById('sheet-contributor');
    const habitId = select.value;
    const habit = STATE.habits.find(h => h.id === habitId);
    if (!habit) return;

    const valueInput = document.getElementById('sheet-value');
    valueInput.value = habit.default_value != null ? habit.default_value : '';

    document.getElementById('sheet-unit-label').textContent = habit.unit || 'mins';

    // FIX #8 / #3: Update duration label based on habit's unit
    const durationLabel = document.getElementById('sheet-duration-label');
    if (habit.unit) {
        durationLabel.textContent = `Value (${habit.unit})`;
    } else {
        durationLabel.textContent = 'Duration';
    }

    const secGroup = document.getElementById('sheet-secondary-group');
    if (habit.has_secondary_metric && habit.secondary_unit) {
        document.getElementById('sheet-secondary-label').textContent = habit.secondary_unit;
        document.getElementById('sheet-secondary-unit-label').textContent = habit.secondary_unit;
        document.getElementById('sheet-secondary-value').value = '';
        secGroup.style.display = '';
    } else {
        secGroup.style.display = 'none';
        document.getElementById('sheet-secondary-value').value = '';
    }
}

function closeLogSheet() {
    document.getElementById('log-sheet').classList.remove('open');
    document.getElementById('sheet-backdrop').classList.remove('visible');
    STATE.selectedCategory = null;
}

async function submitTimeLog(e) {
    e.preventDefault();
    const cat  = STATE.selectedCategory;
    if (!cat) return;

    const habitId = document.getElementById('sheet-contributor').value;
    const habit   = STATE.habits.find(h => h.id === habitId);
    const value   = parseFloat(document.getElementById('sheet-value').value);
    const note    = document.getElementById('sheet-note').value.trim();
    const date    = document.getElementById('sheet-date').value;
    const secVal  = parseFloat(document.getElementById('sheet-secondary-value').value) || null;

    if (!value || value <= 0) { showToast('Enter a valid value.'); return; }
    if (note.length < 3)      { showToast('Add a note (min 3 chars).'); return; }

    const logId = crypto.randomUUID();
    if (STATE.recentLogIds.has(logId)) return;
    STATE.recentLogIds.add(logId);

    const isToday = date === getToday();

    // --- Optimistic update ---
    // FIX #1: Apply optimistic updates for ALL dates (not just today)
    const cs = STATE.stats.category_stats[cat.id] || {};

    if (isToday) {
        cs.today_logged_mins = (cs.today_logged_mins || 0) + value;
        if (!cs.today_contributors) cs.today_contributors = {};
        if (!cs.today_contributors[habitId]) cs.today_contributors[habitId] = { primary: 0 };
        cs.today_contributors[habitId].primary += value;

        const target    = cat.target_minutes || 1;
        const threshold = cat.min_threshold_pct || 60;
        const newPct    = cs.today_logged_mins / target * 100;
        const oldPct    = (cs.today_logged_mins - value) / target * 100;
        if (newPct >= threshold && oldPct < threshold) {
            cs.streak = (cs.streak || 0) + 1;
            if (cs.streak > (cs.best_streak || 0)) cs.best_streak = cs.streak;
        }

        // Update last_7_days for today
        if (cs.last_7_days && cs.last_7_days.length === 7) {
            cs.last_7_days[6].met = newPct >= threshold;
        }

        STATE.stats.category_stats[cat.id] = cs;
    }

    // Update per-habit stats optimistically
    const hs = STATE.stats.habit_stats[habitId] || { total_volume: 0, total_secondary: 0, total_xp: 0, last_log_date: null };
    hs.total_volume += value;
    if (secVal) hs.total_secondary = (hs.total_secondary || 0) + secVal;
    hs.total_xp += value * (habit?.xp_multi || 1);
    if (!hs.last_log_date || date >= hs.last_log_date) hs.last_log_date = date;
    STATE.stats.habit_stats[habitId] = hs;

    // XP toast
    const xpEarned = Math.round(value * (habit?.xp_multi || 1));
    showToast(`+${xpEarned} XP`);

    // Re-render
    if (isToday) {
        rerenderTile(cat);
    }
    updateHeroProfile();

    // Store last-used contributor
    localStorage.setItem(`lastContributor_${cat.id}`, habitId);

    // POST to server
    const logPromise = postLog({
        id: logId,
        logical_date: date,
        habit_id: habitId,
        metric: habit?.metric || 'TIME',
        value,
        note,
        secondary_value: secVal || '',
        secondary_unit: secVal ? (habit?.secondary_unit || '') : ''
    });

    closeLogSheet();

    logPromise.catch(err => console.error('Log sync error:', err));

    // FIX #1: For non-today logs, schedule a server refresh to update
    // streaks and heat strips. Use longer delays to account for Apps Script
    // cold start + write time. Also refresh for today to sync streak state.
    const refreshFromServer = async () => {
        try {
            const freshStats = await getStats();
            if (freshStats && Object.keys(freshStats.category_stats || {}).length > 0) {
                STATE.stats = freshStats;
                saveToCache();
                renderAll();
            }
        } catch (err) {
            console.error('Refresh error:', err);
        }
    };

    if (!isToday) {
        // Backdated log — must refresh from server since we can't
        // accurately compute streak/heat-strip changes client-side
        setTimeout(refreshFromServer, 5000);
        setTimeout(refreshFromServer, 12000);
        setTimeout(refreshFromServer, 20000);  // Third attempt as safety net
    } else {
        // Even for today, do a background refresh to sync server state
        setTimeout(refreshFromServer, 6000);
    }
}

// ============================================================
// BOOL TOGGLE
// FIX #2: Add date-picker modal for backdated BOOL logging
// FIX #5: Track un-checks properly with boolUnchecked map
// ============================================================

function toggleBoolContributor(habitId, catId) {
    const alreadyDone = isCheckedToday(habitId);
    if (alreadyDone) {
        // FIX #5: Mark as unchecked in session.
        // Note: The server-side log still exists. This undo is session-only.
        // On next page refresh, the server state will be authoritative.
        delete STATE.boolChecked[habitId];
        STATE.boolUnchecked[habitId] = true;
    } else {
        STATE.boolChecked[habitId] = true;
        delete STATE.boolUnchecked[habitId];
        const cat = STATE.categories.find(c => c.id === catId);

        const logId = crypto.randomUUID();
        STATE.recentLogIds.add(logId);

        postLog({
            id: logId,
            logical_date: getToday(),
            habit_id: habitId,
            metric: 'BOOL',
            value: 1,
            note: '',
            secondary_value: '',
            secondary_unit: ''
        }).catch(err => console.error('BOOL log sync error:', err));

        if (cat) {
            const cs  = STATE.stats.category_stats[catId] || {};
            const contributors = getCategoryHabits(catId).filter(h => h.active);
            const checkedCount = contributors.filter(h => isCheckedToday(h.id)).length;
            // Check if ALL are now done (for XP toast)
            if (checkedCount === contributors.length && contributors.length > 0) {
                const xp = Math.round((cat.xp_weight || 1) * CONFIG.BOOL_XP_PER_COMPLETION * contributors.length);
                showToast(`+${xp} XP`);
            }
        }
    }

    rerenderTile(STATE.categories.find(c => c.id === catId));
    updateHeroProfile();
}

function isCheckedToday(habitId) {
    // FIX #5: If explicitly unchecked this session, treat as unchecked
    if (STATE.boolUnchecked[habitId]) return false;
    if (STATE.boolChecked[habitId]) return true;
    const hs = STATE.stats.habit_stats?.[habitId];
    return hs?.last_log_date === getToday();
}

// FIX #2: Backdated BOOL logging modal
function openBoolDateModal(cat, catHabits) {
    // Reuse the skill-log-modal for simplicity, but configure it for BOOL
    const modal = document.getElementById('skill-log-modal');
    const form  = document.getElementById('skill-log-form');

    document.getElementById('skill-log-modal-title').textContent = `Log ${cat.name} (Past Date)`;

    // Hide value field (BOOL = always 1)
    document.getElementById('skill-log-value').value = '1';
    document.getElementById('skill-log-value').closest('.input-group').style.display = 'none';

    // Hide secondary
    document.getElementById('skill-log-secondary-group').style.display = 'none';

    // Show date
    document.getElementById('skill-log-date').value = getToday();

    // Notes optional
    document.getElementById('skill-log-note').value = '';

    // Build a checklist inside the modal body for contributor selection
    let checklistContainer = document.getElementById('bool-date-checklist');
    if (!checklistContainer) {
        checklistContainer = document.createElement('div');
        checklistContainer.id = 'bool-date-checklist';
        checklistContainer.style.marginBottom = '14px';
        const modalBody = modal.querySelector('.modal-body');
        modalBody.insertBefore(checklistContainer, modalBody.firstChild.nextSibling);
    }
    checklistContainer.style.display = '';
    checklistContainer.innerHTML = `
        <label style="display:block;margin-bottom:5px;font-size:0.8rem;color:var(--text-secondary);">
            Select contributors completed
        </label>
        ${catHabits.map(h => `
            <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;">
                <input type="checkbox" value="${h.id}" checked
                       style="width:18px;height:18px;accent-color:var(--accent-primary);">
                <span style="font-size:0.9rem;">${h.name}</span>
            </label>
        `).join('')}
    `;

    // Override form submit for BOOL backdated logging
    form.onsubmit = async (e) => {
        e.preventDefault();
        const date = document.getElementById('skill-log-date').value;
        const note = document.getElementById('skill-log-note').value.trim();
        const selectedHabits = Array.from(
            checklistContainer.querySelectorAll('input[type="checkbox"]:checked')
        ).map(cb => cb.value);

        if (selectedHabits.length === 0) {
            showToast('Select at least one contributor.');
            return;
        }

        const btn = form.querySelector('.btn-submit');
        btn.disabled = true;

        try {
            for (const hId of selectedHabits) {
                const logId = crypto.randomUUID();
                await postLog({
                    id: logId,
                    logical_date: date,
                    habit_id: hId,
                    metric: 'BOOL',
                    value: 1,
                    note: note,
                    secondary_value: '',
                    secondary_unit: ''
                });
            }

            showToast(`Logged ${selectedHabits.length} item(s) for ${date}`);
            modal.close();

            // Refresh from server after delay
            setTimeout(async () => {
                try {
                    const freshStats = await getStats();
                    if (freshStats) {
                        STATE.stats = freshStats;
                        saveToCache();
                        renderAll();
                    }
                } catch (err) { console.error(err); }
            }, 5000);
            setTimeout(async () => {
                try {
                    const freshStats = await getStats();
                    if (freshStats) {
                        STATE.stats = freshStats;
                        saveToCache();
                        renderAll();
                    }
                } catch (err) { console.error(err); }
            }, 12000);
        } catch (err) {
            console.error('BOOL date log error:', err);
            showToast('Failed to log.');
        } finally {
            btn.disabled = false;
        }
    };

    modal.showModal();
}

function rerenderTile(cat) {
    if (!cat) return;
    const board = document.getElementById('category-board');
    const existing = board.querySelector(`[data-cat-id="${cat.id}"]`);
    if (!existing) return;

    const cs       = STATE.stats.category_stats?.[cat.id] || {};
    const catHabits = getCategoryHabits(cat.id).filter(h => h.active);
    const newEl    = cat.metric_type === 'BOOL'
        ? renderBoolTile(cat, cs, catHabits)
        : renderTimeTile(cat, cs, catHabits);

    board.replaceChild(newEl, existing);
}

// ============================================================
// SKILL LOG PAGE
// FIX #3: Display volume using the habit's own unit, not always
// converting to hours. Only convert to hours for TIME/mins-based
// habits.
// ============================================================

let skillLogSelectedHabit = null;

function renderSkillLog() {
    const container = document.getElementById('skill-log-list');
    container.innerHTML = '';

    const today = getToday();
    const cats  = [...STATE.categories].sort((a, b) => (a.sort_order || 99) - (b.sort_order || 99));

    cats.forEach(cat => {
        const habits = getCategoryHabits(cat.id);
        if (!habits.length) return;

        const section = document.createElement('div');
        section.className = 'skill-log-section';

        const badgeCls = cat.active ? 'active' : 'inactive';
        const badgeTxt = cat.active ? 'Active' : 'Inactive';

        section.innerHTML = `
            <div class="skill-log-section-header">
                <span class="tile-icon">${cat.icon || '⚡'}</span>
                <span class="skill-log-section-name">${cat.name}</span>
                <span class="skill-log-section-badge ${badgeCls}">${badgeTxt}</span>
            </div>
        `;

        habits.forEach(h => {
            const hs       = STATE.stats.habit_stats?.[h.id] || {};
            const rawVol   = Number(hs.total_volume) || 0;
            const secVol   = Number(hs.total_secondary) || 0;
            const totalXP  = Number(hs.total_xp) || 0;
            const logCount = Number(hs.log_count) || 0;

            // Primary volume label
            const primaryLabel = formatVolumeLabel(rawVol, h.unit, h.metric);

            // Secondary volume label (if applicable)
            let secondaryLabel = '';
            if (h.has_secondary_metric && h.secondary_unit && secVol > 0) {
                secondaryLabel = `${Number(secVol).toFixed(1)} ${h.secondary_unit}`;
            }

            // Last logged
            const lastDate    = hs.last_log_date || null;
            const daysAgo     = lastDate ? daysBetween(lastDate, today) : null;
            const lastLabel   = daysAgo === null ? 'never' : daysAgo === 0 ? 'today' : daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`;
            const coldClass   = daysAgo !== null && daysAgo >= 15 ? 'cold' : '';

            const isInactive  = !cat.active;
            const item = document.createElement('div');
            item.className = `skill-log-item ${isInactive ? 'tappable' : ''}`;

            // Build stat chips
            let statsHTML = `<span class="skill-log-stat-chip">${primaryLabel}</span>`;
            if (secondaryLabel) {
                statsHTML += `<span class="skill-log-stat-chip secondary">${secondaryLabel}</span>`;
            }
            if (logCount > 0) {
                statsHTML += `<span class="skill-log-stat-chip sessions">${logCount} session${logCount !== 1 ? 's' : ''}</span>`;
            }
            if (totalXP > 0) {
                statsHTML += `<span class="skill-log-stat-chip xp">⚡ ${Math.round(totalXP)} XP</span>`;
            }

            item.innerHTML = `
                <div class="skill-log-item-left">
                    <span class="skill-log-item-name">${h.name}</span>
                    <span class="last-logged ${coldClass}">last: ${lastLabel}</span>
                </div>
                <div class="skill-log-item-stats-grid">
                    ${statsHTML}
                </div>
            `;

            if (isInactive) {
                item.addEventListener('click', () => openSkillLogModal(h));
            }

            section.appendChild(item);
        });

        container.appendChild(section);
    });
}

/**
 * FIX #3: Smart volume label formatting.
 * - For TIME metrics with mins/minutes unit → convert to hours
 * - For BOOL metrics → show as "X days"
 * - For everything else (Km, Pages, etc.) → show raw value with unit
 */
function formatVolumeLabel(rawVolume, unit, metric) {
    if (!unit) unit = '';
    const unitLower = unit.toLowerCase();

    if (metric === 'BOOL') {
        return `${Number(rawVolume).toFixed(0)} day(s)`;
    }

    // Time-based: convert minutes to hours
    if (unitLower === 'mins' || unitLower === 'minutes' || unitLower === 'min') {
        const hrs = (rawVolume / 60).toFixed(1);
        return `${hrs} Hrs`;
    }

    // Everything else: show raw value with unit, apply toFixed(1) to avoid floating point
    return `${Number(rawVolume).toFixed(1)} ${unit}`;
}

function openSkillLogModal(habit) {
    skillLogSelectedHabit = habit;

    // Reset the form's onsubmit to default skill log behavior
    document.getElementById('skill-log-form').onsubmit = submitSkillLog;

    // Show value field (may have been hidden by BOOL date modal)
    document.getElementById('skill-log-value').closest('.input-group').style.display = '';

    // Hide BOOL checklist if it exists from previous usage
    const boolChecklist = document.getElementById('bool-date-checklist');
    if (boolChecklist) boolChecklist.style.display = 'none';

    document.getElementById('skill-log-modal-title').textContent = `Log ${habit.name}`;
    document.getElementById('skill-log-value-label').textContent =
        habit.metric === 'TIME' ? `Duration (${habit.unit || 'mins'})` : `Value (${habit.unit || ''})`;
    document.getElementById('skill-log-unit-label').textContent = habit.unit || '';
    document.getElementById('skill-log-value').value = '';
    document.getElementById('skill-log-date').value  = getToday();
    document.getElementById('skill-log-note').value  = '';

    const secGroup = document.getElementById('skill-log-secondary-group');
    if (habit.has_secondary_metric && habit.secondary_unit) {
        document.getElementById('skill-log-secondary-label').textContent = habit.secondary_unit;
        document.getElementById('skill-log-secondary-unit-label').textContent = habit.secondary_unit;
        document.getElementById('skill-log-secondary-value').value = '';
        secGroup.style.display = '';
    } else {
        secGroup.style.display = 'none';
    }

    document.getElementById('skill-log-modal').showModal();
}

async function submitSkillLog(e) {
    e.preventDefault();
    const habit = skillLogSelectedHabit;
    if (!habit) return;

    const value  = parseFloat(document.getElementById('skill-log-value').value);
    const date   = document.getElementById('skill-log-date').value;
    const note   = document.getElementById('skill-log-note').value.trim();
    const secVal = parseFloat(document.getElementById('skill-log-secondary-value').value) || null;

    if (!value || value <= 0) { showToast('Enter a valid value.'); return; }

    const logId = crypto.randomUUID();
    const btn   = document.querySelector('#skill-log-form .btn-submit');
    btn.disabled = true;

    try {
        // Optimistic habit_stats update
        const hs = STATE.stats.habit_stats[habit.id] || { total_volume: 0, total_secondary: 0, total_xp: 0, last_log_date: null };
        hs.total_volume += value;
        if (secVal) hs.total_secondary = (hs.total_secondary || 0) + secVal;
        hs.total_xp += value * (habit.xp_multi || 1) * CONFIG.SKILL_XP_DISCOUNT;
        if (!hs.last_log_date || date >= hs.last_log_date) hs.last_log_date = date;
        STATE.stats.habit_stats[habit.id] = hs;

        showToast(`Logged ${habit.name}`);
        document.getElementById('skill-log-modal').close();
        renderSkillLog();
        updateHeroProfile();

        await postLog({
            id: logId,
            logical_date: date,
            habit_id: habit.id,
            metric: habit.metric,
            value,
            note,
            secondary_value: secVal || '',
            secondary_unit: secVal ? (habit.secondary_unit || '') : ''
        });
    } catch (err) {
        console.error('Skill log error:', err);
    } finally {
        btn.disabled = false;
    }
}

// ============================================================
// STUDIO
// FIX #6: Preserve existing xp_multi instead of hardcoding 1
// ============================================================

function renderStudioCategories() {
    const list = document.getElementById('studio-category-list');
    list.innerHTML = '';

    const sorted = [...STATE.categories].sort((a, b) => (a.sort_order || 99) - (b.sort_order || 99));
    sorted.forEach(cat => {
        const contributors = getCategoryHabits(cat.id).map(h => h.name).join(', ') || '—';
        const typeLabel = cat.metric_type === 'TIME'
            ? `TIME · ${formatTime(cat.target_minutes || 0)} target · ${cat.min_threshold_pct || 60}% min`
            : `BOOL · ${cat.completion_rule || 'ALL'} required`;

        const item = document.createElement('div');
        item.className = `habit-item ${cat.active ? '' : 'archived'}`;
        item.style.borderLeft = `4px solid ${cat.color || '#3b82f6'}`;
        item.innerHTML = `
            <div class="habit-info">
                <h4>${cat.icon || '⚡'} ${cat.name}</h4>
                <div class="habit-meta">${typeLabel} · Sort: ${cat.sort_order || '—'}</div>
                <div class="habit-meta" style="margin-top:2px;">Contributors: ${contributors}</div>
            </div>
            <div class="habit-edit-icon">✎</div>
        `;
        item.addEventListener('click', () => openCategoryConfigModal(cat));
        list.appendChild(item);
    });
}

function renderStudioHabits() {
    const list = document.getElementById('studio-habit-list');
    list.innerHTML = '';

    const sorted = [...STATE.habits].sort((a, b) => a.name.localeCompare(b.name));
    sorted.forEach(h => {
        const cat = STATE.categories.find(c => c.id === h.category_id);
        const metaInfo = [
            cat ? cat.name : (h.category || '—'),
            h.metric,
            h.unit,
            h.default_value != null ? `Default: ${h.default_value}` : null,
            h.has_secondary_metric ? `+${h.secondary_unit}` : null,
            `XP: ${h.xp_multi || 1}x`
        ].filter(Boolean).join(' · ');

        const item = document.createElement('div');
        item.className = `habit-item ${h.active ? '' : 'archived'}`;
        item.innerHTML = `
            <div class="habit-info">
                <h4 style="color:${h.color || 'inherit'}">${h.name}</h4>
                <div class="habit-meta">${metaInfo}</div>
            </div>
            <div class="habit-edit-icon">✎</div>
        `;
        item.addEventListener('click', () => openHabitConfigModal(h));
        list.appendChild(item);
    });
}

function openCategoryConfigModal(cat = null) {
    const isNew = !cat;
    document.getElementById('cat-modal-title').textContent = isNew ? 'New Category' : 'Edit Category';
    document.getElementById('cfg-cat-id').value             = cat?.id || '';
    document.getElementById('cfg-cat-icon').value           = cat?.icon || '';
    document.getElementById('cfg-cat-name').value           = cat?.name || '';
    document.getElementById('cfg-cat-color').value          = cat?.color || '#3b82f6';
    document.getElementById('cfg-cat-metric-type').value    = cat?.metric_type || 'TIME';
    document.getElementById('cfg-cat-tod').value            = cat?.time_of_day || 'ANYTIME';
    document.getElementById('cfg-cat-target').value         = cat?.target_minutes || 60;
    document.getElementById('cfg-cat-threshold').value      = cat?.min_threshold_pct || 60;
    document.getElementById('cfg-cat-completion-rule').value = cat?.completion_rule || 'ALL';
    document.getElementById('cfg-cat-xp-weight').value      = cat?.xp_weight || 1.0;
    document.getElementById('cfg-cat-sort').value           = cat?.sort_order || 99;
    document.getElementById('cfg-cat-active').checked       = isNew ? true : !!cat?.active;
    toggleCatMetricFields();
    document.getElementById('cat-config-modal').showModal();
}

function toggleCatMetricFields() {
    const isTime = document.getElementById('cfg-cat-metric-type').value === 'TIME';
    document.getElementById('cfg-time-fields').style.display  = isTime ? '' : 'none';
    document.getElementById('cfg-bool-fields').style.display  = isTime ? 'none' : '';
}

async function handleCategoryConfigSubmit(e) {
    e.preventDefault();
    const btn = e.target.querySelector('.btn-submit');
    btn.disabled = true;

    const id = document.getElementById('cfg-cat-id').value || crypto.randomUUID();
    const catData = {
        id,
        icon:               document.getElementById('cfg-cat-icon').value.trim(),
        name:               document.getElementById('cfg-cat-name').value.trim(),
        color:              document.getElementById('cfg-cat-color').value,
        metric_type:        document.getElementById('cfg-cat-metric-type').value,
        time_of_day:        document.getElementById('cfg-cat-tod').value,
        target_minutes:     Number(document.getElementById('cfg-cat-target').value),
        min_threshold_pct:  Number(document.getElementById('cfg-cat-threshold').value),
        completion_rule:    document.getElementById('cfg-cat-completion-rule').value,
        xp_weight:          Number(document.getElementById('cfg-cat-xp-weight').value),
        sort_order:         Number(document.getElementById('cfg-cat-sort').value),
        active:             document.getElementById('cfg-cat-active').checked
    };

    try {
        await saveCategory(catData);
        const idx = STATE.categories.findIndex(c => c.id === id);
        if (idx >= 0) STATE.categories[idx] = catData;
        else STATE.categories.push(catData);

        document.getElementById('cat-config-modal').close();
        renderStudioCategories();
        renderBoard();
        showToast('Category saved!');
    } catch (err) {
        console.error(err);
        showToast('Save failed.');
    } finally {
        btn.disabled = false;
    }
}

function openHabitConfigModal(habit = null) {
    const isNew = !habit;
    document.getElementById('habit-modal-title').textContent = isNew ? 'New Habit / Skill' : 'Edit Habit';
    document.getElementById('cfg-habit-id').value            = habit?.id || '';
    document.getElementById('cfg-habit-name').value          = habit?.name || '';
    document.getElementById('cfg-habit-metric').value        = habit?.metric || 'TIME';
    document.getElementById('cfg-habit-unit').value          = habit?.unit || '';
    document.getElementById('cfg-habit-default').value       = habit?.default_value ?? '';
    document.getElementById('cfg-habit-color').value         = habit?.color || '#3b82f6';
    document.getElementById('cfg-habit-secondary').checked   = !!habit?.has_secondary_metric;
    document.getElementById('cfg-habit-secondary-unit').value = habit?.secondary_unit || '';
    document.getElementById('cfg-secondary-unit-group').style.display = habit?.has_secondary_metric ? '' : 'none';
    document.getElementById('cfg-habit-active').checked      = isNew ? true : !!habit?.active;

    // FIX #6: Show XP multiplier field and preserve existing value
    let xpInput = document.getElementById('cfg-habit-xp-multi');
    if (xpInput) {
        xpInput.value = habit?.xp_multi || 1;
    }

    // Populate category dropdown
    const catSelect = document.getElementById('cfg-habit-category');
    catSelect.innerHTML = '<option value="">— select category —</option>';
    STATE.categories.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.icon || ''} ${c.name}`;
        catSelect.appendChild(opt);
    });
    if (habit?.category_id) catSelect.value = habit.category_id;

    document.getElementById('habit-config-modal').showModal();
}

async function handleHabitConfigSubmit(e) {
    e.preventDefault();
    const btn = e.target.querySelector('.btn-submit');
    btn.disabled = true;

    const id = document.getElementById('cfg-habit-id').value || crypto.randomUUID();
    const catId = document.getElementById('cfg-habit-category').value;
    const cat   = STATE.categories.find(c => c.id === catId);

    // FIX #6: Read XP multi from the form, or preserve existing value
    let xpMulti = 1;
    const xpInput = document.getElementById('cfg-habit-xp-multi');
    if (xpInput) {
        xpMulti = Number(xpInput.value) || 1;
    } else {
        // Fallback: preserve existing value from state
        const existingHabit = STATE.habits.find(h => h.id === id);
        xpMulti = existingHabit?.xp_multi || 1;
    }

    const habitData = {
        id,
        name:                 document.getElementById('cfg-habit-name').value.trim(),
        category_id:          catId,
        category:             cat?.name || '',
        metric:               document.getElementById('cfg-habit-metric').value,
        unit:                 document.getElementById('cfg-habit-unit').value.trim(),
        default_value:        document.getElementById('cfg-habit-default').value !== ''
                                ? Number(document.getElementById('cfg-habit-default').value) : null,
        color:                document.getElementById('cfg-habit-color').value,
        has_secondary_metric: document.getElementById('cfg-habit-secondary').checked,
        secondary_unit:       document.getElementById('cfg-habit-secondary-unit').value.trim(),
        active:               document.getElementById('cfg-habit-active').checked,
        xp_multi:             xpMulti   // FIX #6: Use actual value, not hardcoded 1
    };

    try {
        await saveHabit(habitData);
        const idx = STATE.habits.findIndex(h => h.id === id);
        if (idx >= 0) STATE.habits[idx] = habitData;
        else STATE.habits.push(habitData);

        document.getElementById('habit-config-modal').close();
        renderStudioHabits();
        renderBoard();
        showToast('Habit saved!');
    } catch (err) {
        console.error(err);
        showToast('Save failed.');
    } finally {
        btn.disabled = false;
    }
}

// ============================================================
// NAVIGATION
// ============================================================

function switchView(viewName) {
    STATE.view = viewName;

    document.getElementById('view-board').style.display    = viewName === 'board'    ? '' : 'none';
    document.getElementById('view-skilllog').style.display = viewName === 'skilllog' ? '' : 'none';
    document.getElementById('view-studio').style.display   = viewName === 'studio'   ? '' : 'none';

    document.querySelectorAll('.nav-item').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.target === viewName));

    if (viewName === 'skilllog') renderSkillLog();
    if (viewName === 'studio')   { renderStudioCategories(); renderStudioHabits(); }

    toggleDrawer(true);
}

function toggleDrawer(forceClose = false) {
    const drawer   = document.getElementById('app-drawer');
    const backdrop = document.getElementById('drawer-backdrop');
    if (forceClose || drawer.classList.contains('open')) {
        drawer.classList.remove('open');
        backdrop.classList.remove('visible');
    } else {
        drawer.classList.add('open');
        backdrop.classList.add('visible');
    }
}

// ============================================================
// EVENT LISTENERS
// ============================================================

function setupEventListeners() {
    // Drawer
    document.getElementById('profile-trigger').addEventListener('click', () => toggleDrawer());
    document.getElementById('drawer-backdrop').addEventListener('click', () => toggleDrawer(true));
    document.querySelectorAll('.nav-item').forEach(btn =>
        btn.addEventListener('click', () => switchView(btn.dataset.target)));

    // Bottom sheet
    document.getElementById('sheet-close').addEventListener('click', closeLogSheet);
    document.getElementById('sheet-backdrop').addEventListener('click', closeLogSheet);
    document.getElementById('sheet-contributor').addEventListener('change', applyContributorDefaults);
    document.getElementById('log-form').addEventListener('submit', submitTimeLog);

    // Enable submit button only when note has >= 3 chars
    document.getElementById('sheet-note').addEventListener('input', e => {
        document.getElementById('sheet-submit').disabled = e.target.value.trim().length < 3;
    });

    // Category config modal
    document.getElementById('btn-new-category').addEventListener('click', () => openCategoryConfigModal(null));
    document.getElementById('cat-modal-close').addEventListener('click',  () => document.getElementById('cat-config-modal').close());
    document.getElementById('cat-config-modal').addEventListener('click', e => { if (e.target === document.getElementById('cat-config-modal')) e.target.close(); });
    document.getElementById('cfg-cat-metric-type').addEventListener('change', toggleCatMetricFields);
    document.getElementById('cat-config-form').addEventListener('submit', handleCategoryConfigSubmit);

    // Habit config modal
    document.getElementById('btn-new-habit').addEventListener('click', () => openHabitConfigModal(null));
    document.getElementById('habit-modal-close').addEventListener('click',  () => document.getElementById('habit-config-modal').close());
    document.getElementById('habit-config-modal').addEventListener('click', e => { if (e.target === document.getElementById('habit-config-modal')) e.target.close(); });
    document.getElementById('cfg-habit-secondary').addEventListener('change', e => {
        document.getElementById('cfg-secondary-unit-group').style.display = e.target.checked ? '' : 'none';
    });
    document.getElementById('habit-config-form').addEventListener('submit', handleHabitConfigSubmit);

    // Skill log modal
    document.getElementById('skill-log-modal-close').addEventListener('click', () => document.getElementById('skill-log-modal').close());
    document.getElementById('skill-log-modal').addEventListener('click', e => { if (e.target === document.getElementById('skill-log-modal')) e.target.close(); });
    document.getElementById('skill-log-form').addEventListener('submit', submitSkillLog);

    // Studio tabs
    document.querySelectorAll('.studio-tab').forEach(tab =>
        tab.addEventListener('click', () => {
            document.querySelectorAll('.studio-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const isCategories = tab.dataset.tab === 'categories';
            document.getElementById('studio-categories').style.display = isCategories ? '' : 'none';
            document.getElementById('studio-habits').style.display     = isCategories ? 'none' : '';
        })
    );
}

// ============================================================
// CACHE
// ============================================================

function saveToCache() {
    try {
        localStorage.setItem('cache_categories', JSON.stringify(STATE.categories));
        localStorage.setItem('cache_habits',     JSON.stringify(STATE.habits));
        localStorage.setItem('cache_stats',      JSON.stringify(STATE.stats));
        localStorage.setItem('cache_timestamp',  Date.now().toString());
    } catch(e) { /* storage full */ }
}

function loadFromCache() {
    try {
        const ts = parseInt(localStorage.getItem('cache_timestamp') || '0');
        if (Date.now() - ts > CONFIG.CACHE_TTL_MS) return null;
        const categories = JSON.parse(localStorage.getItem('cache_categories') || 'null');
        const habits     = JSON.parse(localStorage.getItem('cache_habits')     || 'null');
        const stats      = JSON.parse(localStorage.getItem('cache_stats')      || 'null');
        if (!categories || !habits || !stats) return null;
        return { categories, habits, stats };
    } catch(e) { return null; }
}

// ============================================================
// UTILITIES
// ============================================================

function getToday() {
    return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
}

function formatTime(mins) {
    mins = Math.round(mins);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

function daysBetween(dateA, dateB) {
    const a = new Date(dateA + 'T00:00:00');
    const b = new Date(dateB + 'T00:00:00');
    return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function getCategoryHabits(catId) {
    return STATE.habits.filter(h => h.category_id === catId);
}

function showToast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2800);
}