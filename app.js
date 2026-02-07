const app = {
    refreshInterval: null,
    eventSource: null,
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
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        this.refresh();
    },

    showAddCluster() {
        document.getElementById('clusterForm').classList.remove('hidden');
        document.getElementById('clusterName').focus();
    },

    hideAddCluster() {
        document.getElementById('clusterForm').classList.add('hidden');
        document.getElementById('clusterName').value = '';
        document.getElementById('clusterEndpoint').value = '';
    },

    addClusterFromForm() {
        const name = document.getElementById('clusterName').value.trim();
        const endpoint = document.getElementById('clusterEndpoint').value.trim();
        if (!name || !endpoint) return;
        this.clusters.push({ name, endpoint });
        this.activeCluster = this.clusters.length - 1;
        this.saveClusters();
        this.renderClusterTabs();
        this.hideAddCluster();
        // Reset + connect
        this.agents = [];
        this.status = null;
        this.jobs = [];
        this.capacityByEndpoint = {};
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        this.refresh();
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
            if (this.refreshInterval) {
                clearInterval(this.refreshInterval);
                this.refreshInterval = null;
            }
            if (this.clusters.length) {
                this.refresh();
            } else {
                this.showAddCluster();
            }
        }
    },

    async fetchAPI(path, options = {}) {
        const resp = await fetch(this.getEndpoint() + path, options);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        if (resp.status === 204) return null;
        return resp.json();
    },

    async fetchAgentCapacity(endpoint) {
        try {
            const resp = await fetch(`${endpoint}/capacity`);
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

            return `
                <tr>
                    <td><code>${a.id}</code></td>
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
        this.refresh();
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
            document.getElementById('runningTasks').textContent = status.running_tasks;
            document.getElementById('totalTasks').textContent = status.total_tasks;
            document.getElementById('leaderAddr').textContent = leaderInfo.leader || 'unknown';

            // Settling indicator
            document.getElementById('statsContainer').classList.toggle('settling', !!status.settling);
            document.getElementById('settleBadge').classList.toggle('active', !!status.settling);

            // Fetch capacity from all agents (real-time usage, always refresh)
            for (const a of agents) {
                this.fetchAgentCapacity(a.endpoint).then(() => this.renderAgentsTable());
            }
            this.renderAgentsTable();

            // Count running tasks per job
            const runningPerJob = {};
            for (const agentTasks of Object.values(status.tasks_by_agent || {})) {
                for (const t of agentTasks) {
                    if (t.state === 'running') {
                        runningPerJob[t.job_name] = (runningPerJob[t.job_name] || 0) + 1;
                    }
                }
            }

            // Jobs table (sorted by name)
            const jobsBody = document.querySelector('#jobsTable tbody');
            const sortedJobs = jobs.sort((a, b) => a.name.localeCompare(b.name));
            jobsBody.innerHTML = sortedJobs.length ? sortedJobs.map(job => {
                const expected = job.count === -1 ? status.agents : (job.count || 1);
                const running = runningPerJob[job.name] || 0;
                const ok = running >= expected;
                const statusClass = ok ? 'status-ok' : 'status-degraded';
                const statusText = ok ? 'OK' : 'DEGRADED';
                return `
                <tr>
                    <td>${job.name}</td>
                    <td><code>${this.truncate(job.command, 30)}</code></td>
                    <td>${running} / ${job.count === -1 ? 'all(' + expected + ')' : expected}</td>
                    <td class="${statusClass}">${statusText}</td>
                    <td><button class="danger small" onclick="app.deleteJob('${job.name}')">Delete</button></td>
                </tr>`;
            }).join('') : '<tr><td colspan="5" class="empty">No jobs</td></tr>';

            // Tasks table (flattened from all agents, sorted by job_name)
            const tasksBody = document.querySelector('#tasksTable tbody');
            const tasks = [];
            for (const [agentId, agentTasks] of Object.entries(status.tasks_by_agent || {})) {
                const agent = agents.find(a => a.id === agentId);
                for (const t of agentTasks) {
                    tasks.push({ ...t, agentId, agentEndpoint: agent?.endpoint });
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

            // Auto-refresh (always on)
            if (!this.refreshInterval) {
                this.refreshInterval = setInterval(() => this.refresh(), 5000);
            }
        } catch (err) {
            // Show error but keep polling - cluster might come back
            document.getElementById('error').innerHTML = `<div class="warning">Waiting for cluster... (${err.message})</div>`;

            // Keep auto-refresh running
            if (!this.refreshInterval) {
                this.refreshInterval = setInterval(() => this.refresh(), 5000);
            }
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
        if (this.eventSource) {
            this.eventSource.close();
        }

        const { taskId, agentEndpoint } = this.currentTask;
        const url = `${agentEndpoint}/logs/${taskId}/${this.currentStream}`;

        document.getElementById('logOutput').textContent += `Connecting to ${url}...\n`;

        this.eventSource = new EventSource(url);

        this.eventSource.onopen = () => {
            document.getElementById('logOutput').textContent += '[Connected]\n';
        };

        this.eventSource.onmessage = (event) => {
            const output = document.getElementById('logOutput');
            // SSE strips trailing newline, add it back
            output.textContent += event.data + '\n';
            output.scrollTop = output.scrollHeight;
        };

        this.eventSource.onerror = () => {
            document.getElementById('logOutput').textContent += '\n[Connection closed]\n';
            this.eventSource.close();
            this.eventSource = null;
        };
    },

    closeLogs() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
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

    truncate(str, len) {
        if (!str) return '';
        return str.length > len ? str.slice(0, len) + '...' : str;
    }
};

// Enter in cluster form submits
document.getElementById('clusterEndpoint').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') app.addClusterFromForm();
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
    app.refresh();
} else {
    app.showAddCluster();
}
