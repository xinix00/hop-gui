const $ = id => document.getElementById(id);

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
    clusterSSE: null, refreshTimer: null, detailTimer: null, fallbackTimer: null,
    logAbort: null, currentTask: null, currentStream: 'stdout',
    activeJobId: null, _skipPush: false, _dragSrcIdx: null,
    agents: [], status: null, jobs: [], capacityByEndpoint: {},
    clusters: [], activeCluster: 0,
    connectedEndpoint: null, _poolEndpoints: [], _poolIdx: 0,

    // ── Cluster config ─────────────────────────────

    getConfiguredEndpoint() {
        const c = this.clusters[this.activeCluster];
        const ep = c ? c.endpoint : 'localhost:8080';
        return ep.startsWith('http') ? ep : 'http://' + ep;
    },

    getEndpoint() { return this.connectedEndpoint || this.getConfiguredEndpoint(); },

    authHeaders() {
        const key = this.clusters[this.activeCluster]?.apiKey;
        return key ? { 'X-API-Key': key } : {};
    },

    loadClusters() {
        try {
            const stored = localStorage.getItem('hop-clusters');
            if (stored) this.clusters = JSON.parse(stored);
        } catch (e) { /* ignore */ }
        if (!this.clusters.length) this.clusters = [];
        const active = localStorage.getItem('hop-active-cluster');
        this.activeCluster = active !== null ? Math.min(Number(active), this.clusters.length - 1) : 0;
    },

    saveClusters() {
        localStorage.setItem('hop-clusters', JSON.stringify(this.clusters));
        localStorage.setItem('hop-active-cluster', String(this.activeCluster));
    },

    renderClusterTabs() {
        $('clusterTabs').innerHTML = this.clusters.map((c, i) =>
            `<button class="cluster-tab${i === this.activeCluster ? ' active' : ''}" onclick="app.switchCluster(${i})">` +
                `${c.name}<span class="cluster-tab-remove" onclick="event.stopPropagation(); app.removeCluster(${i})">×</span>` +
            `</button>`
        ).join('');
    },

    _resetState() {
        this.agents = [];
        this.status = null;
        this.jobs = [];
        this.capacityByEndpoint = {};
        this.connectedEndpoint = null;
        this._poolIdx = 0;
    },

    switchCluster(index) {
        if (index === this.activeCluster) return;
        this.activeCluster = index;
        this.saveClusters();
        this.renderClusterTabs();
        this._resetState();
        this.activeJobId = null;
        this._stopFallbackPoll();
        this._loadPool();
        this.connectSSE();
    },

    showAddCluster() { $('clusterForm').classList.remove('hidden'); $('clusterName').focus(); },

    hideAddCluster() {
        $('clusterForm').classList.add('hidden');
        $('clusterName').value = '';
        $('clusterEndpoint').value = '';
        $('clusterApiKey').value = '';
    },

    addClusterFromForm() {
        const name = $('clusterName').value.trim();
        const endpoint = $('clusterEndpoint').value.trim();
        const apiKey = $('clusterApiKey').value.trim();
        if (!name || !endpoint) return;
        const cluster = { name, endpoint };
        if (apiKey) cluster.apiKey = apiKey;
        this.clusters.push(cluster);
        this.activeCluster = this.clusters.length - 1;
        this.saveClusters();
        this.renderClusterTabs();
        this.hideAddCluster();
        this._resetState();
        this._poolEndpoints = [];
        this.connectSSE();
    },

    removeCluster(index) {
        if (!confirm(`Remove cluster "${this.clusters[index].name}"?`)) return;
        const wasActive = index === this.activeCluster;
        this.clusters.splice(index, 1);
        if (this.activeCluster >= this.clusters.length) this.activeCluster = Math.max(0, this.clusters.length - 1);
        else if (index < this.activeCluster) this.activeCluster--;
        this.saveClusters();
        this.renderClusterTabs();
        if (wasActive) {
            this._resetState();
            this._stopFallbackPoll();
            if (this.clusters.length) { this._loadPool(); this.connectSSE(); }
            else { this.disconnectSSE(); this.showAddCluster(); }
        }
    },

    // ── API ────────────────────────────────────────

    async fetchAPI(path, options = {}) {
        const headers = { ...this.authHeaders(), ...(options.headers || {}) };
        const resp = await fetch(this.getEndpoint() + path, { ...options, headers });
        if (!resp.ok) throw new Error(httpStatusMessage(resp.status));
        return resp.status === 204 ? null : resp.json();
    },

    async fetchAgentCapacity(endpoint) {
        try {
            const resp = await fetch(`${endpoint}/capacity`, { headers: this.authHeaders() });
            if (resp.ok) this.capacityByEndpoint[endpoint] = await resp.json();
        } catch (e) { /* agent might not be reachable */ }
    },

    // ── SSE + failover pool ────────────────────────

    _buildEndpointList() {
        const configured = this.getConfiguredEndpoint();
        const seen = new Set([configured]);
        const list = [configured];
        for (const ep of this._poolEndpoints) {
            const norm = ep.startsWith('http') ? ep : 'http://' + ep;
            if (!seen.has(norm)) { seen.add(norm); list.push(norm); }
        }
        return list;
    },

    _updatePool() {
        this._poolEndpoints = this.agents.map(a => a.endpoint).filter(Boolean);
        const c = this.clusters[this.activeCluster];
        if (c) {
            try { localStorage.setItem(`hop-pool-${c.name}`, JSON.stringify(this._poolEndpoints)); }
            catch (e) { /* ignore */ }
        }
    },

    _loadPool() {
        this._poolEndpoints = [];
        const c = this.clusters[this.activeCluster];
        if (!c) return;
        try {
            const stored = localStorage.getItem(`hop-pool-${c.name}`);
            if (stored) this._poolEndpoints = JSON.parse(stored);
        } catch (e) { /* ignore */ }
    },

    _startFallbackPoll() {
        if (this.fallbackTimer) return;
        this.fallbackTimer = setInterval(() => this.refresh(), 10000);
    },

    _stopFallbackPoll() {
        if (this.fallbackTimer) { clearInterval(this.fallbackTimer); this.fallbackTimer = null; }
    },

    _tryNextEndpoint() {
        this._poolIdx++;
        const endpoints = this._buildEndpointList();
        const total = endpoints.length;
        this._startFallbackPoll();
        if (this._poolIdx >= total) {
            this.setSseStatus(false, `All ${total} agent(s) unreachable — retrying in 10s`);
            this._poolIdx = 0;
            setTimeout(() => this.connectSSE(), 10000);
        } else {
            const next = endpoints[this._poolIdx].replace(/^https?:\/\//, '');
            this.setSseStatus(false, `Trying ${next}... (${this._poolIdx + 1}/${total})`);
            setTimeout(() => this.connectSSE(), 1000);
        }
    },

    disconnectSSE() {
        if (this.clusterSSE) { this.clusterSSE.abort(); this.clusterSSE = null; }
    },

    setSseStatus(ok, msg) {
        const el = $('sseStatus');
        if (!el) return;
        el.className = ok ? 'sse-ok' : 'sse-error';
        el.textContent = ok ? '' : (msg || 'SSE disconnected — retrying…');
    },

    connect() { this._loadPool(); this.connectSSE(); },

    async connectSSE() {
        this.disconnectSSE();
        const endpoints = this._buildEndpointList();
        if (!endpoints.length) return;

        const endpoint = endpoints[this._poolIdx % endpoints.length];
        const abort = new AbortController();
        this.clusterSSE = abort;

        try {
            const resp = await fetch(endpoint + '/v1/events', {
                headers: this.authHeaders(), signal: abort.signal
            });
            if (!resp.ok || !resp.body) {
                // Agent is reachable but returned an error — don't failover,
                // show the specific error and retry the same endpoint
                this.setSseStatus(false, httpStatusMessage(resp.status));
                this._startFallbackPoll();
                setTimeout(() => this.connectSSE(), 10000);
                return;
            }

            this.connectedEndpoint = endpoint;
            this._poolIdx = 0;
            this.setSseStatus(true);
            this._stopFallbackPoll();
            this.refresh();

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '', event = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) throw new Error('SSE stream ended');
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('event: ')) event = line.slice(7).trim();
                    else if (line.startsWith('data:') && event !== 'ping') {
                        clearTimeout(this.refreshTimer);
                        this.refreshTimer = setTimeout(() => this.refresh(), 500);
                    } else if (line === '') event = '';
                }
            }
        } catch (e) {
            if (!abort.signal.aborted) this._tryNextEndpoint();
        }
    },

    // ── Navigation ─────────────────────────────────

    showTab(name) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.tab[onclick*="${name}"]`).classList.add('active');
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        $(`tab-${name}`).classList.add('active');
        if (name === 'jobs') {
            this.activeJobId = null;
            $('jobDetailView').classList.add('hidden');
            $('jobsListView').classList.remove('hidden');
        }
        if (!this._skipPush) history.pushState(null, '', '#' + name);
    },

    navigateToHash() {
        const hash = location.hash || '#agents';
        this._skipPush = true;
        this.closeLogs();
        if (hash.startsWith('#jobs/')) this.openJobDetail(decodeURIComponent(hash.slice(6)));
        else if (hash === '#jobs') this.showTab('jobs');
        else this.showTab('agents');
        this._skipPush = false;
    },

    // ── Data refresh ───────────────────────────────

    async refresh() {
        try {
            $('error').innerHTML = '';
            const [status, jobs, agents, leaderInfo] = await Promise.all([
                this.fetchAPI('/v1/status'),
                this.fetchAPI('/v1/jobs'),
                this.fetchAPI('/v1/agents'),
                this.fetchAPI('/leader')
            ]);

            this.agents = agents;
            this.status = status;
            this.jobs = jobs;
            this._updatePool();

            $('agentCount').textContent = status.agents;
            $('totalPlaced').textContent = status.total_placed;
            $('totalJobs').textContent = status.jobs;
            $('leaderAddr').textContent = leaderInfo.leader || 'unknown';
            $('statsContainer').classList.toggle('settling', !!status.settling);
            $('settleBadge').classList.toggle('active', !!status.settling);

            for (const a of agents) this.fetchAgentCapacity(a.endpoint).then(() => this.renderAgentsTable());
            this.renderAgentsTable();
            this.renderJobsTable(jobs, status.placed || {}, status.agents);
            if (this.activeJobId) this.refreshJobDetail(this.activeJobId);

            $('lastUpdate').textContent = new Date().toLocaleTimeString();
        } catch (err) {
            $('error').innerHTML = `<div class="warning">Waiting for cluster... (${err.message})</div>`;
        }
    },

    // ── Agents table ───────────────────────────────

    renderAgentsTable() {
        const tbody = document.querySelector('#agentsTable tbody');
        if (!this.agents.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No agents</td></tr>'; return; }
        tbody.innerHTML = [...this.agents].sort((a, b) => a.id.localeCompare(b.id)).map(a => {
            const cap = this.capacityByEndpoint[a.endpoint];
            const cpu = cap ? `${(cap.cpu_used_shares / 1024).toFixed(1)}/${cap.cpu_cores}` : '-';
            const mem = cap ? `${this.formatBytes(cap.memory_used_bytes)}/${this.formatBytes(cap.memory_bytes)}` : '-';
            const tooltip = cap ? this.formatAttributes(cap.attributes) : '';
            const conn = a.endpoint === this.connectedEndpoint;
            return `<tr>
                <td data-label="ID"><code${tooltip ? ` data-tooltip="${tooltip}"` : ''}>${a.id}</code></td>
                <td data-label="Version"><span class="version">${a.version || 'unknown'}</span></td>
                <td data-label="Endpoint"><code>${a.endpoint}</code>${conn ? ' <span class="connected-dot">●</span>' : ''}</td>
                <td data-label="CPU">${cpu}</td>
                <td data-label="Memory">${mem}</td>
                <td data-label="Tasks">${cap ? cap.tasks_running : '-'}</td>
            </tr>`;
        }).join('');
    },

    // ── Jobs table ─────────────────────────────────

    sortedByPriority(jobs) {
        return [...jobs].sort((a, b) => {
            const pa = a.priority != null ? a.priority : Infinity;
            const pb = b.priority != null ? b.priority : Infinity;
            return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
        });
    },

    renderJobsTable(jobs, placedPerJob, agentCount) {
        const tbody = document.querySelector('#jobsTable tbody');
        const sorted = this.sortedByPriority(jobs);
        if (!sorted.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No jobs</td></tr>'; return; }
        tbody.innerHTML = sorted.map((job, idx) => {
            const expected = job.count === -1 ? agentCount : (job.count || 1);
            const running = placedPerJob[job.name] || 0;
            const ok = running >= expected;
            const prio = job.priority != null ? `<span class="prio-badge">${job.priority}</span>` : '<span class="prio-badge">—</span>';
            const tip = this.formatJobTooltip(job);
            return `<tr class="clickable" draggable="true" data-job-id="${job.name}" data-drag-idx="${idx}"
                onclick="app.openJobDetail('${job.name}')"
                ondragstart="app.onDragStart(event,${idx})" ondragover="app.onDragOver(event)"
                ondragleave="app.onDragLeave(event)" ondrop="app.onDrop(event,${idx})" ondragend="app.onDragEnd(event)">
                <td class="mobile-hide" onclick="event.stopPropagation()"><span class="drag-handle">⠿</span></td>
                <td data-label="Prio">${prio}</td>
                <td data-label="Name"><code${tip ? ` data-tooltip="${tip}"` : ''}>${job.name}</code></td>
                <td data-label="Running">${running} / ${job.count === -1 ? 'all(' + expected + ')' : expected}</td>
                <td data-label="Status" class="${ok ? 'status-ok' : 'status-degraded'}">${ok ? 'OK' : 'DEGRADED'}</td>
                <td class="mobile-actions"><button class="danger small" onclick="event.stopPropagation(); app.deleteJob('${job.name}')">Delete</button></td>
            </tr>`;
        }).join('');
    },

    toggleNewJob() { $('newJobForm').classList.toggle('hidden'); },

    async startJob() {
        const jsonStr = $('jobJson').value.trim();
        if (!jsonStr) { alert('Enter job JSON'); return; }
        let job;
        try { job = JSON.parse(jsonStr); }
        catch (e) { alert('Invalid JSON: ' + e.message); return; }
        try {
            await this.fetchAPI('/v1/jobs', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job)
            });
            $('jobJson').value = '';
            this.toggleNewJob();
            this.refresh();
        } catch (err) { alert('Failed to start job: ' + err.message); }
    },

    async redeployJob(jobName) {
        if (!confirm(`Redeploy job ${jobName}? This triggers a rolling update.`)) return;
        try {
            const jobs = await this.fetchAPI('/v1/jobs');
            const job = jobs.find(j => j.name === jobName);
            if (!job) throw new Error('Job not found');
            await this.fetchAPI('/v1/jobs', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job)
            });
            this.refresh();
        } catch (err) { alert('Failed to redeploy: ' + err.message); }
    },

    async deleteJob(jobName) {
        if (!confirm(`Delete job ${jobName}?`)) return;
        try {
            await this.fetchAPI(`/v1/jobs/${jobName}`, { method: 'DELETE' });
            if (this.activeJobId === jobName) this.closeJobDetail();
            this.refresh();
        } catch (err) { alert('Failed to delete job: ' + err.message); }
    },

    // ── Drag & drop priority ───────────────────────

    onDragStart(e, idx) {
        this._dragSrcIdx = idx;
        e.currentTarget.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drag-over'); },
    onDragLeave(e) { e.currentTarget.classList.remove('drag-over'); },
    onDragEnd(e) {
        e.currentTarget.classList.remove('dragging');
        document.querySelectorAll('tr.drag-over').forEach(r => r.classList.remove('drag-over'));
        this._dragSrcIdx = null;
    },

    async onDrop(e, toIdx) {
        e.preventDefault();
        e.currentTarget.classList.remove('drag-over');
        const fromIdx = this._dragSrcIdx;
        if (fromIdx === null || fromIdx === toIdx) return;

        const sorted = this.sortedByPriority(this.jobs);
        const [moved] = sorted.splice(fromIdx, 1);
        sorted.splice(toIdx, 0, moved);
        sorted.forEach((job, i) => { job.priority = i; });

        this.renderJobsTable(this.jobs, this.status?.placed || {}, this.agents.length);

        try {
            await this.fetchAPI(`/v1/jobs/${moved.name}/priority`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ priority: toIdx }),
            });
        } catch (err) { console.error('Priority update failed:', err); this.refresh(); }
    },

    // ── Job detail ─────────────────────────────────

    async openJobDetail(jobId) {
        this.activeJobId = jobId;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.tab[onclick*="jobs"]').classList.add('active');
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        $('tab-jobs').classList.add('active');
        $('jobsListView').classList.add('hidden');
        $('jobDetailView').classList.remove('hidden');
        $('jobDetailName').textContent = jobId;
        $('jobDetailDelete').onclick = () => this.deleteJob(jobId);
        $('jobDetailRedeploy').onclick = () => this.redeployJob(jobId);
        if (!this._skipPush) history.pushState(null, '', '#jobs/' + encodeURIComponent(jobId));

        document.querySelector('#jobTasksTable tbody').innerHTML = '<tr><td colspan="8" class="empty">Loading...</td></tr>';
        await this.refreshJobDetail(jobId);

        clearInterval(this.detailTimer);
        this.detailTimer = setInterval(() => { if (this.activeJobId) this.refreshJobDetail(this.activeJobId); }, 5000);
    },

    _renderJobInfo(job) {
        const tags = [];
        if (job.image) tags.push(`image: ${job.image}`);
        if (job.driver) tags.push(job.driver);
        tags.push(`count: ${job.count === -1 ? 'all agents' : (job.count || 1)}`);
        if (job.update_policy) tags.push(`update: ${job.update_policy}`);
        if (job.cpu_shares) tags.push(`cpu: ${job.cpu_shares}`);
        if (job.memory_limit) tags.push(`mem: ${this.formatBytes(job.memory_limit)}`);
        if (job.max_restarts != null) tags.push(`restarts: ${job.max_restarts === -1 ? '∞' : job.max_restarts}`);
        if (job.tags) for (const [k, v] of Object.entries(job.tags)) tags.push(`${k}=${v}`);
        if (job.affinity) for (const [k, v] of Object.entries(job.affinity)) tags.push(`affinity: ${k}=${v}`);

        let html = `<div class="detail-tags">${tags.map(t => `<span class="detail-tag">${t}</span>`).join(' ')}</div>`;

        if (job.command) {
            html += `<details class="detail-section"><summary>Command</summary><pre class="detail-pre">${this._esc(job.command)}</pre></details>`;
        }
        if (job.artifacts?.length) {
            const rows = job.artifacts.map(a => {
                const match = a.match ? Object.entries(a.match).map(([k,v]) => `${k}=${v}`).join(', ') : '';
                return `<tr><td data-label="URL"><code>${a.url}</code></td><td data-label="Match">${match}</td><td data-label="Filename">${a.filename || ''}</td><td data-label="Extract">${a.extract || 'binary'}</td></tr>`;
            }).join('');
            html += `<details class="detail-section" open><summary>Artifacts</summary><table class="detail-table"><thead><tr><th>URL</th><th>Match</th><th>Filename</th><th>Extract</th></tr></thead><tbody>${rows}</tbody></table></details>`;
        }
        if (job.volumes && Object.keys(job.volumes).length) {
            const rows = Object.entries(job.volumes).map(([h, t]) =>
                `<tr><td data-label="Host"><code>${h}</code></td><td data-label="Task"><code>${t}</code></td></tr>`
            ).join('');
            html += `<details class="detail-section" open><summary>Volumes</summary><table class="detail-table"><thead><tr><th>Host Path</th><th>Task Path</th></tr></thead><tbody>${rows}</tbody></table></details>`;
        }
        if (job.env && Object.keys(job.env).length) {
            const entries = Object.entries(job.env).sort();
            const rows = entries.map(([k, v]) =>
                `<tr><td data-label="Key"><code>${k}</code></td><td data-label="Value"><code>${v}</code></td></tr>`
            ).join('');
            html += `<details class="detail-section"><summary>Environment (${entries.length})</summary><table class="detail-table"><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></details>`;
        }
        return html;
    },

    async refreshJobDetail(jobId) {
        const job = this.jobs.find(j => j.name === jobId);
        if (!job) { this.closeJobDetail(); return; }

        // Render info, preserving open/closed state of <details>
        const info = $('jobDetailInfo');
        const openState = {};
        info.querySelectorAll('details').forEach(d => {
            const key = d.querySelector('summary')?.textContent;
            if (key) openState[key] = d.open;
        });
        info.innerHTML = this._renderJobInfo(job);
        info.querySelectorAll('details').forEach(d => {
            const key = d.querySelector('summary')?.textContent;
            if (key && key in openState) d.open = openState[key];
        });

        // Status badge
        const placed = this.status?.placed || {};
        const expected = job.count === -1 ? (this.status?.agents || 0) : (job.count || 1);
        const running = placed[job.name] || 0;
        const ok = running >= expected;
        $('jobDetailStatus').textContent = `${running}/${expected}`;
        $('jobDetailStatus').className = 'status ' + (ok ? 'running' : 'failed');

        // Tasks
        try {
            const js = await this.fetchAPI(`/v1/jobs/${jobId}/status`);
            const tasks = [];
            if (js?.tasks_by_agent) {
                for (const [agentId, agentTasks] of Object.entries(js.tasks_by_agent)) {
                    const agent = this.agents.find(a => a.id === agentId);
                    for (const t of agentTasks) tasks.push({ ...t, agentId, agentEndpoint: agent?.endpoint });
                }
            }
            tasks.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.id.localeCompare(b.id));

            const tbody = document.querySelector('#jobTasksTable tbody');
            const existing = {};
            tbody.querySelectorAll('tr[data-task-id]').forEach(r => { existing[r.dataset.taskId] = r; });

            if (tasks.length && tasks.length === Object.keys(existing).length && tasks.every(t => existing[t.id])) {
                for (const t of tasks) {
                    const row = existing[t.id];
                    row.querySelector('.task-cpu').textContent = this.formatPercent(t.cpu_percent);
                    row.querySelector('.task-mem').textContent = this.formatPercent(t.mem_percent);
                    row.querySelector('.task-restarts').textContent = t.restart_count || 0;
                    const s = row.querySelector('.task-state');
                    s.className = 'status task-state ' + t.state;
                    s.textContent = t.state;
                }
            } else {
                tbody.innerHTML = tasks.length ? tasks.map(t => `<tr data-task-id="${t.id}">
                    <td data-label="Task"><code>${t.id.slice(0, 8)}</code></td>
                    <td data-label="Agent"><code>${t.agentId}</code></td>
                    <td data-label="Ports">${this.formatPorts(t.ports)}</td>
                    <td data-label="CPU" class="task-cpu">${this.formatPercent(t.cpu_percent)}</td>
                    <td data-label="Mem" class="task-mem">${this.formatPercent(t.mem_percent)}</td>
                    <td data-label="Restarts" class="task-restarts">${t.restart_count || 0}</td>
                    <td data-label="State"><span class="status task-state ${t.state}">${t.state}</span></td>
                    <td class="mobile-actions"><button class="small" onclick="app.openLogs('${t.id}','${t.agentEndpoint}')">Logs</button></td>
                </tr>`).join('') : '<tr><td colspan="8" class="empty">No tasks</td></tr>';
            }
        } catch (err) {
            document.querySelector('#jobTasksTable tbody').innerHTML =
                `<tr><td colspan="8" class="empty">Failed to load tasks: ${err.message}</td></tr>`;
        }
    },

    closeJobDetail() {
        clearInterval(this.detailTimer);
        this.activeJobId = null;
        $('jobDetailView').classList.add('hidden');
        $('jobsListView').classList.remove('hidden');
        if (!this._skipPush) history.pushState(null, '', '#jobs');
    },

    // ── Log viewer ─────────────────────────────────

    openLogs(taskId, agentEndpoint) {
        this.currentTask = { taskId, agentEndpoint };
        this.currentStream = 'stdout';
        $('logTaskId').textContent = taskId.slice(0, 8);
        $('logOutput').textContent = '';
        $('logModal').classList.remove('hidden');
        $('btnStdout').classList.add('active');
        $('btnStderr').classList.remove('active');
        this.startLogStream();
    },

    switchStream(stream) {
        this.currentStream = stream;
        $('btnStdout').classList.toggle('active', stream === 'stdout');
        $('btnStderr').classList.toggle('active', stream === 'stderr');
        $('logOutput').textContent = '';
        this.startLogStream();
    },

    async startLogStream() {
        if (this.logAbort) this.logAbort.abort();
        const { taskId, agentEndpoint } = this.currentTask;
        const url = `${agentEndpoint}/logs/${taskId}/${this.currentStream}`;
        const abort = new AbortController();
        this.logAbort = abort;
        const output = $('logOutput');
        output.textContent += `Connecting to ${url}...\n`;

        try {
            const resp = await fetch(url, { headers: this.authHeaders(), signal: abort.signal });
            if (!resp.ok || !resp.body) { output.textContent += `[Error: HTTP ${resp.status}]\n`; return; }
            output.textContent += '[Connected]\n';
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('data:')) output.textContent += line.slice(5) + '\n';
                }
                output.scrollTop = output.scrollHeight;
            }
            output.textContent += '\n[Connection closed]\n';
        } catch (e) {
            if (!abort.signal.aborted) output.textContent += `\n[Error: ${e.message}]\n`;
        }
    },

    closeLogs() {
        if (this.logAbort) { this.logAbort.abort(); this.logAbort = null; }
        $('logModal').classList.add('hidden');
        this.currentTask = null;
    },

    // ── Formatters ─────────────────────────────────

    formatBytes(bytes) {
        if (bytes == null) return '-';
        if (bytes === 0) return '0';
        for (const [unit, size] of [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]]) {
            if (bytes >= size) return `${(bytes / size).toFixed(unit === 'GB' ? 1 : 0)} ${unit}`;
        }
        return `${bytes} B`;
    },

    formatPercent(val) { return val != null ? val.toFixed(1) + '%' : '-'; },

    formatPorts(ports) {
        if (!ports || !Object.keys(ports).length) return '-';
        return Object.entries(ports).map(([k, v]) => `${k}:${v}`).join(', ');
    },

    formatAttributes(attrs) {
        if (!attrs || !Object.keys(attrs).length) return '';
        return Object.keys(attrs).sort().map(k => `${k}=${attrs[k]}`).join('\n');
    },

    formatJobTooltip(job) {
        const parts = [];
        if (job.affinity && Object.keys(job.affinity).length)
            parts.push('Affinity: ' + Object.entries(job.affinity).sort().map(([k,v]) => `${k}=${v}`).join(', '));
        if (job.artifacts?.length) {
            for (const a of job.artifacts) {
                const match = a.match && Object.keys(a.match).length
                    ? Object.entries(a.match).sort().map(([k,v]) => `${k}=${v}`).join(',') + ' → ' : '';
                parts.push('Artifact: ' + match + a.url);
            }
        }
        if (job.image) parts.push('Image: ' + job.image);
        if (job.tags && Object.keys(job.tags).length)
            parts.push('Tags: ' + Object.entries(job.tags).sort().map(([k,v]) => `${k}=${v}`).join(', '));
        return parts.join('\n');
    },

    _esc(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;'); },
};

// Keyboard shortcuts
$('clusterApiKey').addEventListener('keypress', e => { if (e.key === 'Enter') app.addClusterFromForm(); });
$('clusterEndpoint').addEventListener('keypress', e => { if (e.key === 'Enter') $('clusterApiKey').focus(); });
$('clusterName').addEventListener('keypress', e => { if (e.key === 'Enter') $('clusterEndpoint').focus(); });
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { app.closeLogs(); app.hideAddCluster(); if (app.activeJobId) app.closeJobDetail(); }
});
window.addEventListener('popstate', () => app.navigateToHash());

// Init
app.loadClusters();
app.renderClusterTabs();
if (app.clusters.length) {
    app.connect();
    if (location.hash) app.navigateToHash();
    else history.replaceState(null, '', '#agents');
} else {
    app.showAddCluster();
}
