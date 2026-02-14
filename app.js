const app = {
    clusterSSE: null,
    refreshPending: false,
    logAbort: null,
    currentTask: null,
    currentStream: 'stdout',
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
        // Reset state for new cluster
        this.agents = [];
        this.status = null;
        this.jobs = [];
        this.capacityByEndpoint = {};
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
        // Reset + connect
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
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
        } catch (e) {
            // Ignore - agent might not be reachable
        }
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
            agentsBody.innerHTML = '<tr><td colspan="7" class="empty">No agents</td></tr>';
            return;
        }

        // Sort agents by ID
        const sorted = [...this.agents].sort((a, b) => a.id.localeCompare(b.id));

        agentsBody.innerHTML = sorted.map(a => {
            const cap = this.capacityByEndpoint[a.endpoint];

            // CPU: show "used/total" as cores (shares / 1024 = cores)
            let cpuStr = '-';
            if (cap) {
                const usedCores = (cap.cpu_used_shares / 1024).toFixed(1);
                cpuStr = `${usedCores}/${cap.cpu_cores}`;
            }

            // Memory: show "used/total" compact
            let memStr = '-';
            if (cap) {
                memStr = `${this.formatBytes(cap.memory_used_bytes)}/${this.formatBytes(cap.memory_bytes)}`;
            }

            // Tasks running
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
                    <td>${this.formatTime(a.last_seen)}</td>
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

    // SSE via fetch (supports custom headers, unlike EventSource)
    connectSSE() {
        this.disconnectSSE();
        this.refresh(); // immediate first fetch

        const abort = new AbortController();
        this.clusterSSE = abort;

        const url = this.getEndpoint() + '/v1/events';
        fetch(url, { headers: this.authHeaders(), signal: abort.signal })
            .then(resp => {
                if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';

                const read = () => {
                    reader.read().then(({ done, value }) => {
                        if (done) throw new Error('SSE stream ended');
                        buf += decoder.decode(value, { stream: true });
                        // Process complete lines
                        const lines = buf.split('\n');
                        buf = lines.pop(); // keep incomplete line
                        for (const line of lines) {
                            if (line.startsWith('event: changed') || line.startsWith('data:')) {
                                if (!this.refreshPending) {
                                    this.refreshPending = true;
                                    setTimeout(() => {
                                        this.refreshPending = false;
                                        this.refresh();
                                    }, 500);
                                }
                            }
                        }
                        read();
                    }).catch(() => {
                        // Stream closed or aborted — retry if not manually disconnected
                        if (!abort.signal.aborted) {
                            setTimeout(() => this.connectSSE(), 5000);
                        }
                    });
                };
                read();
            })
            .catch(() => {
                if (!abort.signal.aborted) {
                    setTimeout(() => this.connectSSE(), 5000);
                }
            });
    },

    showTab(name) {
        // Update tab buttons
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.tab[onclick*="${name}"]`).classList.add('active');

        // Update tab content
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        document.getElementById(`tab-${name}`).classList.add('active');
    },

    toggleNewJob() {
        document.getElementById('newJobForm').classList.toggle('hidden');
    },

    async startJob() {
        const jsonStr = document.getElementById('jobJson').value.trim();
        if (!jsonStr) {
            alert('Enter job JSON');
            return;
        }

        let job;
        try {
            job = JSON.parse(jsonStr);
        } catch (e) {
            alert('Invalid JSON: ' + e.message);
            return;
        }

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
            this.refresh();
        } catch (err) {
            alert('Failed to delete job: ' + err.message);
        }
    },

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

            // Stats
            document.getElementById('agentCount').textContent = status.agents;
            document.getElementById('totalPlaced').textContent = status.total_placed;
            document.getElementById('totalJobs').textContent = status.jobs;
            document.getElementById('leaderAddr').textContent = leaderInfo.leader || 'unknown';

            // Settling indicator
            document.getElementById('statsContainer').classList.toggle('settling', !!status.settling);
            document.getElementById('settleBadge').classList.toggle('active', !!status.settling);

            // Fetch capacity from all agents (real-time usage, always refresh)
            for (const a of agents) {
                this.fetchAgentCapacity(a.endpoint).then(() => this.renderAgentsTable());
            }
            this.renderAgentsTable();

            // Placed counts per job from status (already aggregated by leader)
            const placedPerJob = status.placed || {};

            // Jobs table (sorted by name)
            const jobsBody = document.querySelector('#jobsTable tbody');
            const sortedJobs = jobs.sort((a, b) => a.name.localeCompare(b.name));
            jobsBody.innerHTML = sortedJobs.length ? sortedJobs.map(job => {
                const expected = job.count === -1 ? status.agents : (job.count || 1);
                const running = placedPerJob[job.name] || 0;
                const ok = running >= expected;
                const statusClass = ok ? 'status-ok' : 'status-degraded';
                const statusText = ok ? 'OK' : 'DEGRADED';
                const jobTip = this.formatJobTooltip(job);

                return `
                <tr>
                    <td><code${jobTip ? ` data-tooltip="${jobTip}"` : ''}>${job.name}</code></td>
                    <td><code${job.command && job.command.length > 30 ? ` data-tooltip="${job.command}"` : ''}>${this.truncate(job.command, 30)}</code></td>
                    <td>${running} / ${job.count === -1 ? 'all(' + expected + ')' : expected}</td>
                    <td class="${statusClass}">${statusText}</td>
                    <td><button class="danger small" onclick="app.deleteJob('${job.name}')">Delete</button></td>
                </tr>`;
            }).join('') : '<tr><td colspan="5" class="empty">No jobs</td></tr>';

            // Tasks table: fetch per-job status in parallel
            const tasksBody = document.querySelector('#tasksTable tbody');
            const tasks = [];
            const jobStatuses = await Promise.all(
                jobs.map(job => this.fetchAPI(`/v1/jobs/${job.name}/status`).catch(() => null))
            );
            for (let i = 0; i < jobs.length; i++) {
                const js = jobStatuses[i];
                if (!js || !js.tasks_by_agent) continue;
                for (const [agentId, agentTasks] of Object.entries(js.tasks_by_agent)) {
                    const agent = agents.find(a => a.id === agentId);
                    for (const t of agentTasks) {
                        tasks.push({ ...t, agentId, agentEndpoint: agent?.endpoint });
                    }
                }
            }

            // Sort by job name, then by ID
            tasks.sort((a, b) => {
                const nameCompare = a.job_name.localeCompare(b.job_name);
                return nameCompare !== 0 ? nameCompare : a.id.localeCompare(b.id);
            });

            tasksBody.innerHTML = tasks.length ? tasks.map(t => `
                <tr>
                    <td><code>${t.id.slice(0, 8)}</code></td>
                    <td>${t.job_name}</td>
                    <td><code>${t.agentId}</code></td>
                    <td>${this.formatPorts(t.ports)}</td>
                    <td><span class="status ${t.state}">${t.state}</span></td>
                    <td>
                        ${t.state === 'running' || t.state === 'stopping' ? `<button class="small" onclick="app.openLogs('${t.id}', '${t.agentEndpoint}')">Logs</button>` : '-'}
                    </td>
                </tr>
            `).join('') : '<tr><td colspan="6" class="empty">No tasks</td></tr>';

            document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
        } catch (err) {
            document.getElementById('error').innerHTML = `<div class="warning">Waiting for cluster... (${err.message})</div>`;
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
        if (this.logAbort) {
            this.logAbort.abort();
        }

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
                            if (line.startsWith('data:')) {
                                output.textContent += line.slice(5) + '\n';
                            }
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
        if (this.logAbort) {
            this.logAbort.abort();
            this.logAbort = null;
        }
        document.getElementById('logModal').classList.add('hidden');
        this.currentTask = null;
    },

    formatTime(isoString) {
        if (!isoString) return '-';
        const d = new Date(isoString);
        return d.toLocaleTimeString();
    },

    formatPorts(ports) {
        if (!ports || Object.keys(ports).length === 0) return '-';
        return Object.entries(ports).map(([k, v]) => `${k}:${v}`).join(', ');
    },

    formatAttributes(attrs) {
        if (!attrs || Object.keys(attrs).length === 0) return '';
        return Object.keys(attrs).sort().map(k => `${k}=${attrs[k]}`).join('\n');
    },

    formatAffinity(affinity) {
        if (!affinity || Object.keys(affinity).length === 0) return '';
        return Object.keys(affinity).sort().map(k => `${k}=${affinity[k]}`).join('\n');
    },

    formatJobTooltip(job) {
        const parts = [];
        if (job.affinity && Object.keys(job.affinity).length > 0) {
            parts.push('Affinity: ' + Object.keys(job.affinity).sort().map(k => `${k}=${job.affinity[k]}`).join(', '));
        }
        if (job.artifacts && job.artifacts.length > 0) {
            job.artifacts.forEach(a => {
                const match = a.match && Object.keys(a.match).length > 0
                    ? Object.keys(a.match).sort().map(k => `${k}=${a.match[k]}`).join(',') + ' → '
                    : '';
                parts.push('Artifact: ' + match + a.url);
            });
        }
        if (job.image) {
            parts.push('Image: ' + job.image);
        }
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

// Enter in cluster form submits
document.getElementById('clusterApiKey').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') app.addClusterFromForm();
});
document.getElementById('clusterEndpoint').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('clusterApiKey').focus();
});
document.getElementById('clusterName').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('clusterEndpoint').focus();
});

// Close modal on escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        app.closeLogs();
        app.hideAddCluster();
    }
});

// Initial load
app.loadClusters();
app.renderClusterTabs();
if (app.clusters.length) {
    app.connect();
} else {
    app.showAddCluster();
}
