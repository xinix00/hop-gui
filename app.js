function httpStatusMessage(status) {
    switch (status) {
        case 502: return 'HTTP 502 — agent cannot reach the leader (leader down or election in progress)';
        case 503: return 'HTTP 503 — no leader available yet (election in progress)';
        case 401: return 'HTTP 401 — authentication failed (check API key)';
        case 403: return 'HTTP 403 — access denied (check API key)';
        default:  return `HTTP ${status}`;
    }
}

const app = {
    clusterSSE: null,
    refreshTimer: null,
    detailTimer: null,
    logAbort: null,
    currentTask: null,
    currentStream: 'stdout',
    activeJobId: null, // currently viewed job detail
    _skipPush: false, // true when navigating via popstate (don't push again)
    agents: [],
    status: null,
    jobs: [],
    capacityByEndpoint: {},
    clusters: [],
    activeCluster: 0,

    getEndpoint() {
        const c = this.clusters[this.activeCluster];
        const ep = c ? c.endpoint : 'localhost:8080';
        return ep.startsWith('http') ? ep : 'http://' + ep;
    },

    getApiKey() {
        const c = this.clusters[this.activeCluster];
        return c ? (c.apiKey || '') : '';
    },

    authHeaders() {
        const h = {};
        const key = this.getApiKey();
        if (key) h['X-API-Key'] = key;
        return h;
    },

    loadClusters() {
        try {
            const stored = localStorage.getItem('easyrun-clusters');
            if (stored) {
                this.clusters = JSON.parse(stored);
            }
        } catch (e) { /* ignore */ }
        if (!this.clusters.length) {
            this.clusters = [];
        }
        const active = localStorage.getItem('easyrun-active-cluster');
        this.activeCluster = active !== null ? Math.min(Number(active), this.clusters.length - 1) : 0;
    },

    saveClusters() {
        localStorage.setItem('easyrun-clusters', JSON.stringify(this.clusters));
        localStorage.setItem('easyrun-active-cluster', String(this.activeCluster));
    },

    renderClusterTabs() {
        const container = document.getElementById('clusterTabs');
        container.innerHTML = this.clusters.map((c, i) =>
            `<button class="cluster-tab${i === this.activeCluster ? ' active' : ''}" onclick="app.switchCluster(${i})">` +
                `${c.name}` +
                `<span class="cluster-tab-remove" onclick="event.stopPropagation(); app.removeCluster(${i})">×</span>` +
            `</button>`
        ).join('');
    },

    switchCluster(index) {
        if (index === this.activeCluster) return;
        this.activeCluster = index;
        this.saveClusters();
        this.renderClusterTabs();
        this.agents = [];
        this.status = null;
        this.jobs = [];
        this.capacityByEndpoint = {};
        this.activeJobId = null;
        this.connectSSE();
    },

    showAddCluster() {
        document.getElementById('clusterForm').classList.remove('hidden');
        document.getElementById('clusterName').focus();
    },

    hideAddCluster() {
        document.getElementById('clusterForm').classList.add('hidden');
        document.getElementById('clusterName').value = '';
        document.getElementById('clusterEndpoint').value = '';
        document.getElementById('clusterApiKey').value = '';
    },

    addClusterFromForm() {
        const name = document.getElementById('clusterName').value.trim();
        const endpoint = document.getElementById('clusterEndpoint').value.trim();
        const apiKey = document.getElementById('clusterApiKey').value.trim();
        if (!name || !endpoint) return;
        const cluster = { name, endpoint };
        if (apiKey) cluster.apiKey = apiKey;
        this.clusters.push(cluster);
        this.activeCluster = this.clusters.length - 1;
        this.saveClusters();
        this.renderClusterTabs();
        this.hideAddCluster();
        this.agents = [];
        this.status = null;
        this.jobs = [];
        this.capacityByEndpoint = {};
        this.connectSSE();
    },

    removeCluster(index) {
        if (!confirm(`Remove cluster "${this.clusters[index].name}"?`)) return;
        const wasActive = index === this.activeCluster;
        this.clusters.splice(index, 1);
        if (this.activeCluster >= this.clusters.length) {
            this.activeCluster = Math.max(0, this.clusters.length - 1);
        } else if (index < this.activeCluster) {
            this.activeCluster--;
        }
        this.saveClusters();
        this.renderClusterTabs();
        if (wasActive) {
            this.agents = [];
            this.status = null;
            this.jobs = [];
            this.capacityByEndpoint = {};
            if (this.clusters.length) {
                this.connectSSE();
            } else {
                this.disconnectSSE();
                this.showAddCluster();
            }
        }
    },

    async fetchAPI(path, options = {}) {
        const headers = { ...this.authHeaders(), ...(options.headers || {}) };
        const resp = await fetch(this.getEndpoint() + path, { ...options, headers });
        if (!resp.ok) throw new Error(httpStatusMessage(resp.status));
        if (resp.status === 204) return null;
        return resp.json();
    },

    async fetchAgentCapacity(endpoint) {
        try {
            const resp = await fetch(`${endpoint}/capacity`, { headers: this.authHeaders() });
            if (resp.ok) {
                const data = await resp.json();
                this.capacityByEndpoint[endpoint] = data;
                return data;
            }
        } catch (e) { /* agent might not be reachable */ }
        return null;
    },

    formatBytes(bytes) {
        if (bytes === null || bytes === undefined) return '-';
        if (bytes === 0) return '0';
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1) return `${gb.toFixed(1)} GB`;
        const mb = bytes / (1024 * 1024);
        if (mb >= 1) return `${mb.toFixed(0)} MB`;
        const kb = bytes / 1024;
        if (kb >= 1) return `${kb.toFixed(0)} KB`;
        return `${bytes} B`;
    },

    renderAgentsTable() {
        const agentsBody = document.querySelector('#agentsTable tbody');
        if (!this.agents.length) {
            agentsBody.innerHTML = '<tr><td colspan="6" class="empty">No agents</td></tr>';
            return;
        }
        const sorted = [...this.agents].sort((a, b) => a.id.localeCompare(b.id));
        agentsBody.innerHTML = sorted.map(a => {
            const cap = this.capacityByEndpoint[a.endpoint];
            let cpuStr = '-';
            if (cap) {
                const usedCores = (cap.cpu_used_shares / 1024).toFixed(1);
                cpuStr = `${usedCores}/${cap.cpu_cores}`;
            }
            let memStr = '-';
            if (cap) {
                memStr = `${this.formatBytes(cap.memory_used_bytes)}/${this.formatBytes(cap.memory_bytes)}`;
            }
            const tasksStr = cap ? cap.tasks_running : '-';
            const attrTitle = cap ? this.formatAttributes(cap.attributes) : '';
            return `
                <tr>
                    <td><code${attrTitle ? ` data-tooltip="${attrTitle}"` : ''}>${a.id}</code></td>
                    <td><span class="version">${a.version || 'unknown'}</span></td>
                    <td><code>${a.endpoint}</code></td>
                    <td>${cpuStr}</td>
                    <td>${memStr}</td>
                    <td>${tasksStr}</td>
                </tr>`;
        }).join('');
    },

    connect() {
        this.connectSSE();
    },

    disconnectSSE() {
        if (this.clusterSSE) {
            this.clusterSSE.abort();
            this.clusterSSE = null;
        }
    },

    setSseStatus(connected, msg) {
        const el = document.getElementById('sseStatus');
        if (!el) return;
        if (connected) {
            el.className = 'sse-ok';
            el.textContent = '';
        } else {
            el.className = 'sse-error';
            el.textContent = msg || 'SSE disconnected — retrying…';
        }
    },

    connectSSE() {
        this.disconnectSSE();

        const abort = new AbortController();
        this.clusterSSE = abort;

        const url = this.getEndpoint() + '/v1/events';
        fetch(url, { headers: this.authHeaders(), signal: abort.signal })
            .then(resp => {
                if (!resp.ok || !resp.body) throw new Error(httpStatusMessage(resp.status));
                this.setSseStatus(true);
                this.refresh();
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';
                let currentEvent = '';
                const read = () => {
                    reader.read().then(({ done, value }) => {
                        if (done) throw new Error('SSE stream ended');
                        buf += decoder.decode(value, { stream: true });
                        const lines = buf.split('\n');
                        buf = lines.pop();
                        for (const line of lines) {
                            if (line.startsWith('event: ')) {
                                currentEvent = line.slice(7).trim();
                            } else if (line.startsWith('data:')) {
                                if (currentEvent !== 'ping') {
                                    console.log('[SSE] event:', currentEvent, '→ refresh triggered');
                                    clearTimeout(this.refreshTimer);
                                    this.refreshTimer = setTimeout(() => this.refresh(), 500);
                                }
                            } else if (line === '') {
                                currentEvent = '';
                            }
                        }
                        read();
                    }).catch(err => {
                        if (!abort.signal.aborted) {
                            this.setSseStatus(false, `SSE error: ${err.message} — retrying in 5s`);
                            setTimeout(() => this.connectSSE(), 5000);
                        }
                    });
                };
                read();
            })
            .catch(err => {
                if (!abort.signal.aborted) {
                    this.setSseStatus(false, `SSE failed: ${err.message} — retrying in 5s`);
                    setTimeout(() => this.connectSSE(), 5000);
                }
            });
    },

    showTab(name) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.tab[onclick*="${name}"]`).classList.add('active');
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        document.getElementById(`tab-${name}`).classList.add('active');

        // When switching to jobs tab, close detail view
        if (name === 'jobs') {
            this.activeJobId = null;
            document.getElementById('jobDetailView').classList.add('hidden');
            document.getElementById('jobsListView').classList.remove('hidden');
        }

        if (!this._skipPush) {
            history.pushState(null, '', '#' + name);
        }
    },

    toggleNewJob() {
        document.getElementById('newJobForm').classList.toggle('hidden');
    },

    async startJob() {
        const jsonStr = document.getElementById('jobJson').value.trim();
        if (!jsonStr) { alert('Enter job JSON'); return; }

        let job;
        try { job = JSON.parse(jsonStr); }
        catch (e) { alert('Invalid JSON: ' + e.message); return; }

        try {
            await this.fetchAPI('/v1/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(job)
            });
            document.getElementById('jobJson').value = '';
            this.toggleNewJob();
            this.refresh();
        } catch (err) {
            alert('Failed to start job: ' + err.message);
        }
    },

    async deleteJob(jobName) {
        if (!confirm(`Delete job ${jobName}?`)) return;
        try {
            await this.fetchAPI(`/v1/jobs/${jobName}`, { method: 'DELETE' });
            if (this.activeJobId === jobName) this.closeJobDetail();
            this.refresh();
        } catch (err) {
            alert('Failed to delete job: ' + err.message);
        }
    },

    // Main refresh: lightweight (no per-job task fetching)
    async refresh() {
        try {
            document.getElementById('error').innerHTML = '';

            const [status, jobs, agents, leaderInfo] = await Promise.all([
                this.fetchAPI('/v1/status'),
                this.fetchAPI('/v1/jobs'),
                this.fetchAPI('/v1/agents'),
                this.fetchAPI('/leader')
            ]);

            this.agents = agents;
            this.status = status;
            this.jobs = jobs;

            document.getElementById('agentCount').textContent = status.agents;
            document.getElementById('totalPlaced').textContent = status.total_placed;
            document.getElementById('totalJobs').textContent = status.jobs;
            document.getElementById('leaderAddr').textContent = leaderInfo.leader || 'unknown';

            document.getElementById('statsContainer').classList.toggle('settling', !!status.settling);
            document.getElementById('settleBadge').classList.toggle('active', !!status.settling);

            // Agents
            for (const a of agents) {
                this.fetchAgentCapacity(a.endpoint).then(() => this.renderAgentsTable());
            }
            this.renderAgentsTable();

            // Jobs table
            const placedPerJob = status.placed || {};
            this.renderJobsTable(jobs, placedPerJob, status.agents);

            // If job detail is open, refresh it too
            if (this.activeJobId) {
                this.refreshJobDetail(this.activeJobId);
            }

            document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
        } catch (err) {
            document.getElementById('error').innerHTML = `<div class="warning">Waiting for cluster... (${err.message})</div>`;
        }
    },

    // Sort jobs by effective priority: null/undefined sorts last, 0 = most important.
    sortedByPriority(jobs) {
        return [...jobs].sort((a, b) => {
            const pa = a.priority != null ? a.priority : Infinity;
            const pb = b.priority != null ? b.priority : Infinity;
            return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
        });
    },

    renderJobsTable(jobs, placedPerJob, agentCount) {
        const jobsBody = document.querySelector('#jobsTable tbody');
        const sortedJobs = this.sortedByPriority(jobs);

        if (!sortedJobs.length) {
            jobsBody.innerHTML = '<tr><td colspan="7" class="empty">No jobs</td></tr>';
            return;
        }

        jobsBody.innerHTML = sortedJobs.map((job, idx) => {
            const expected = job.count === -1 ? agentCount : (job.count || 1);
            const running = placedPerJob[job.name] || 0;
            const ok = running >= expected;
            const statusClass = ok ? 'status-ok' : 'status-degraded';
            const statusText = ok ? 'OK' : 'DEGRADED';
            const jobTip = this.formatJobTooltip(job);
            const prioLabel = job.priority != null ? `<span class="prio-badge">${job.priority}</span>` : '<span class="prio-badge">—</span>';

            return `
            <tr class="clickable" draggable="true" data-job-id="${job.name}" data-drag-idx="${idx}"
                onclick="app.openJobDetail('${job.name}')"
                ondragstart="app.onDragStart(event, ${idx})"
                ondragover="app.onDragOver(event)"
                ondragleave="app.onDragLeave(event)"
                ondrop="app.onDrop(event, ${idx})"
                ondragend="app.onDragEnd(event)">
                <td onclick="event.stopPropagation()"><span class="drag-handle">⠿</span></td>
                <td>${prioLabel}</td>
                <td><code${jobTip ? ` data-tooltip="${jobTip}"` : ''}>${job.name}</code></td>
                <td><code${job.command && job.command.length > 30 ? ` data-tooltip="${job.command}"` : ''}>${this.truncate(job.command || job.image || '', 30)}</code></td>
                <td>${running} / ${job.count === -1 ? 'all(' + expected + ')' : expected}</td>
                <td class="${statusClass}">${statusText}</td>
                <td><button class="danger small" onclick="event.stopPropagation(); app.deleteJob('${job.name}')">Delete</button></td>
            </tr>`;
        }).join('');
    },

    _dragSrcIdx: null,

    onDragStart(event, idx) {
        this._dragSrcIdx = idx;
        event.currentTarget.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
    },

    onDragOver(event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        event.currentTarget.classList.add('drag-over');
    },

    onDragLeave(event) {
        event.currentTarget.classList.remove('drag-over');
    },

    onDragEnd(event) {
        event.currentTarget.classList.remove('dragging');
        document.querySelectorAll('tr.drag-over').forEach(r => r.classList.remove('drag-over'));
        this._dragSrcIdx = null;
    },

    async onDrop(event, toIdx) {
        event.preventDefault();
        event.currentTarget.classList.remove('drag-over');
        const fromIdx = this._dragSrcIdx;
        if (fromIdx === null || fromIdx === toIdx) return;

        // Reorder the sorted list
        const sorted = this.sortedByPriority(this.jobs);
        const [moved] = sorted.splice(fromIdx, 1);
        sorted.splice(toIdx, 0, moved);

        // Optimistic local reorder so UI responds immediately
        sorted.splice(fromIdx, 1);
        sorted.splice(toIdx, 0, moved);
        sorted.forEach((job, i) => { job.priority = i; });

        const placedPerJob = (this.status && this.status.placed) || {};
        this.renderJobsTable(this.jobs, placedPerJob, this.agents.length);

        // One PATCH — server inserts the job at toIdx and renumbers everything
        try {
            await this.fetchAPI(`/v1/jobs/${moved.name}/priority`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ priority: toIdx }),
            });
        } catch (err) {
            console.error('Priority update failed:', err);
            this.refresh();
        }
    },

    // Open job detail view
    async openJobDetail(jobId) {
        this.activeJobId = jobId;

        // Ensure we're on the jobs tab
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.tab[onclick*="jobs"]').classList.add('active');
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        document.getElementById('tab-jobs').classList.add('active');

        document.getElementById('jobsListView').classList.add('hidden');
        document.getElementById('jobDetailView').classList.remove('hidden');

        document.getElementById('jobDetailName').textContent = jobId;
        document.getElementById('jobDetailDelete').onclick = () => this.deleteJob(jobId);

        if (!this._skipPush) {
            history.pushState(null, '', '#jobs/' + encodeURIComponent(jobId));
        }

        // Show loading state
        document.querySelector('#jobTasksTable tbody').innerHTML =
            '<tr><td colspan="8" class="empty">Loading...</td></tr>';

        await this.refreshJobDetail(jobId);

        // Poll task resources every 5s (CPU/Mem don't trigger SSE events)
        clearInterval(this.detailTimer);
        this.detailTimer = setInterval(() => {
            if (this.activeJobId) this.refreshJobDetail(this.activeJobId);
        }, 5000);
    },

    async refreshJobDetail(jobId) {
        const job = this.jobs.find(j => j.name === jobId);
        if (!job) {
            this.closeJobDetail();
            return;
        }

        // Job info bar
        const info = document.getElementById('jobDetailInfo');
        const parts = [];
        if (job.command) parts.push(`<code>${job.command}</code>`);
        if (job.image) parts.push(`<span class="detail-tag">image: ${job.image}</span>`);
        if (job.driver) parts.push(`<span class="detail-tag">${job.driver}</span>`);
        const countLabel = job.count === -1 ? 'all agents' : (job.count || 1);
        parts.push(`<span class="detail-tag">count: ${countLabel}</span>`);
        if (job.update_policy) parts.push(`<span class="detail-tag">update: ${job.update_policy}</span>`);
        if (job.tags && Object.keys(job.tags).length > 0) {
            for (const [k, v] of Object.entries(job.tags)) {
                parts.push(`<span class="detail-tag">${k}=${v}</span>`);
            }
        }
        info.innerHTML = parts.join(' ');

        // Status badge
        const placedPerJob = (this.status && this.status.placed) || {};
        const expected = job.count === -1 ? (this.status?.agents || 0) : (job.count || 1);
        const running = placedPerJob[job.name] || 0;
        const ok = running >= expected;
        const statusEl = document.getElementById('jobDetailStatus');
        statusEl.textContent = `${running}/${expected}`;
        statusEl.className = 'status ' + (ok ? 'running' : 'failed');

        // Fetch tasks for this job
        try {
            const js = await this.fetchAPI(`/v1/jobs/${jobId}/status`);
            const tasks = [];
            if (js && js.tasks_by_agent) {
                for (const [agentId, agentTasks] of Object.entries(js.tasks_by_agent)) {
                    const agent = this.agents.find(a => a.id === agentId);
                    for (const t of agentTasks) {
                        tasks.push({ ...t, agentId, agentEndpoint: agent?.endpoint });
                    }
                }
            }
            tasks.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.id.localeCompare(b.id));

            const tbody = document.querySelector('#jobTasksTable tbody');
            // If rows already exist, only update CPU/Mem cells in-place
            const existingRows = tbody.querySelectorAll('tr[data-task-id]');
            const existingMap = {};
            existingRows.forEach(row => { existingMap[row.dataset.taskId] = row; });

            if (tasks.length && Object.keys(existingMap).length > 0 &&
                tasks.length === Object.keys(existingMap).length &&
                tasks.every(t => existingMap[t.id])) {
                // In-place update: only refresh CPU, Mem, restarts, and state
                for (const t of tasks) {
                    const row = existingMap[t.id];
                    row.querySelector('.task-cpu').textContent = this.formatPercent(t.cpu_percent);
                    row.querySelector('.task-mem').textContent = this.formatPercent(t.mem_percent);
                    row.querySelector('.task-restarts').textContent = t.restart_count || 0;
                    const stateEl = row.querySelector('.task-state');
                    stateEl.className = 'status task-state ' + t.state;
                    stateEl.textContent = t.state;
                }
            } else {
                // Full render (new tasks, different count, etc.)
                tbody.innerHTML = tasks.length ? tasks.map(t => `
                    <tr data-task-id="${t.id}">
                        <td><code>${t.id.slice(0, 8)}</code></td>
                        <td><code>${t.agentId}</code></td>
                        <td>${this.formatPorts(t.ports)}</td>
                        <td class="task-cpu">${this.formatPercent(t.cpu_percent)}</td>
                        <td class="task-mem">${this.formatPercent(t.mem_percent)}</td>
                        <td class="task-restarts">${t.restart_count || 0}</td>
                        <td><span class="status task-state ${t.state}">${t.state}</span></td>
                        <td>
                            <button class="small" onclick="app.openLogs('${t.id}', '${t.agentEndpoint}')">Logs</button>
                        </td>
                    </tr>
                `).join('') : '<tr><td colspan="8" class="empty">No tasks</td></tr>';
            }
        } catch (err) {
            document.querySelector('#jobTasksTable tbody').innerHTML =
                `<tr><td colspan="8" class="empty">Failed to load tasks: ${err.message}</td></tr>`;
        }
    },

    closeJobDetail() {
        clearInterval(this.detailTimer);
        this.activeJobId = null;
        document.getElementById('jobDetailView').classList.add('hidden');
        document.getElementById('jobsListView').classList.remove('hidden');
        if (!this._skipPush) {
            history.pushState(null, '', '#jobs');
        }
    },

    openLogs(taskId, agentEndpoint) {
        this.currentTask = { taskId, agentEndpoint };
        this.currentStream = 'stdout';
        document.getElementById('logTaskId').textContent = taskId.slice(0, 8);
        document.getElementById('logOutput').textContent = '';
        document.getElementById('logModal').classList.remove('hidden');
        document.getElementById('btnStdout').classList.add('active');
        document.getElementById('btnStderr').classList.remove('active');
        this.startLogStream();
    },

    switchStream(stream) {
        this.currentStream = stream;
        document.getElementById('btnStdout').classList.toggle('active', stream === 'stdout');
        document.getElementById('btnStderr').classList.toggle('active', stream === 'stderr');
        document.getElementById('logOutput').textContent = '';
        this.startLogStream();
    },

    startLogStream() {
        if (this.logAbort) this.logAbort.abort();

        const { taskId, agentEndpoint } = this.currentTask;
        const url = `${agentEndpoint}/logs/${taskId}/${this.currentStream}`;
        const abort = new AbortController();
        this.logAbort = abort;

        document.getElementById('logOutput').textContent += `Connecting to ${url}...\n`;

        fetch(url, { headers: this.authHeaders(), signal: abort.signal })
            .then(resp => {
                if (!resp.ok || !resp.body) {
                    document.getElementById('logOutput').textContent += `[Error: HTTP ${resp.status}]\n`;
                    return;
                }
                document.getElementById('logOutput').textContent += '[Connected]\n';
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';
                const read = () => {
                    reader.read().then(({ done, value }) => {
                        if (done) {
                            document.getElementById('logOutput').textContent += '\n[Connection closed]\n';
                            return;
                        }
                        buf += decoder.decode(value, { stream: true });
                        const lines = buf.split('\n');
                        buf = lines.pop();
                        const output = document.getElementById('logOutput');
                        for (const line of lines) {
                            if (line.startsWith('data:')) output.textContent += line.slice(5) + '\n';
                        }
                        output.scrollTop = output.scrollHeight;
                        read();
                    }).catch(() => {
                        document.getElementById('logOutput').textContent += '\n[Connection closed]\n';
                    });
                };
                read();
            })
            .catch(err => {
                if (!abort.signal.aborted) {
                    document.getElementById('logOutput').textContent += `\n[Error: ${err.message}]\n`;
                }
            });
    },

    closeLogs() {
        if (this.logAbort) { this.logAbort.abort(); this.logAbort = null; }
        document.getElementById('logModal').classList.add('hidden');
        this.currentTask = null;
    },

    navigateToHash() {
        const hash = location.hash || '#agents';
        this._skipPush = true;
        this.closeLogs();
        if (hash.startsWith('#jobs/')) {
            const jobId = decodeURIComponent(hash.slice(6));
            this.openJobDetail(jobId);
        } else if (hash === '#jobs') {
            this.showTab('jobs');
        } else {
            this.showTab('agents');
        }
        this._skipPush = false;
    },

    formatPercent(val) {
        if (val === undefined || val === null) return '-';
        return val.toFixed(1) + '%';
    },

    formatPorts(ports) {
        if (!ports || Object.keys(ports).length === 0) return '-';
        return Object.entries(ports).map(([k, v]) => `${k}:${v}`).join(', ');
    },

    formatAttributes(attrs) {
        if (!attrs || Object.keys(attrs).length === 0) return '';
        return Object.keys(attrs).sort().map(k => `${k}=${attrs[k]}`).join('\n');
    },

    formatJobTooltip(job) {
        const parts = [];
        if (job.affinity && Object.keys(job.affinity).length > 0) {
            parts.push('Affinity: ' + Object.keys(job.affinity).sort().map(k => `${k}=${job.affinity[k]}`).join(', '));
        }
        if (job.artifacts && job.artifacts.length > 0) {
            job.artifacts.forEach(a => {
                const match = a.match && Object.keys(a.match).length > 0
                    ? Object.keys(a.match).sort().map(k => `${k}=${a.match[k]}`).join(',') + ' \u2192 '
                    : '';
                parts.push('Artifact: ' + match + a.url);
            });
        }
        if (job.image) parts.push('Image: ' + job.image);
        if (job.tags && Object.keys(job.tags).length > 0) {
            parts.push('Tags: ' + Object.keys(job.tags).sort().map(k => `${k}=${job.tags[k]}`).join(', '));
        }
        return parts.join('\n');
    },

    truncate(str, len) {
        if (!str) return '';
        return str.length > len ? str.slice(0, len) + '...' : str;
    }
};

// Keyboard shortcuts
document.getElementById('clusterApiKey').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') app.addClusterFromForm();
});
document.getElementById('clusterEndpoint').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('clusterApiKey').focus();
});
document.getElementById('clusterName').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('clusterEndpoint').focus();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        app.closeLogs();
        app.hideAddCluster();
        if (app.activeJobId) app.closeJobDetail();
    }
});

// Browser history
window.addEventListener('popstate', () => app.navigateToHash());

// Initial load
app.loadClusters();
app.renderClusterTabs();
if (app.clusters.length) {
    app.connect();
    // Restore view from URL hash (bookmarks, refresh)
    if (location.hash) {
        app.navigateToHash();
    } else {
        history.replaceState(null, '', '#agents');
    }
} else {
    app.showAddCluster();
}
