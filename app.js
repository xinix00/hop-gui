const app = {
    refreshInterval: null,
    eventSource: null,
    currentTask: null,
    currentStream: 'stdout',
    agents: [],
    status: null,
    jobs: [],
    capacityCache: {}, // endpoint -> {cpu_cores, memory_bytes}

    getEndpoint() {
        const ep = document.getElementById('endpoint').value;
        return ep.startsWith('http') ? ep : 'http://' + ep;
    },

    async fetchAPI(path, options = {}) {
        const resp = await fetch(this.getEndpoint() + path, options);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        if (resp.status === 204) return null;
        return resp.json();
    },

    async fetchAgentCapacity(endpoint) {
        // Return cached value if we have it
        if (this.capacityCache[endpoint]) {
            return this.capacityCache[endpoint];
        }
        try {
            const resp = await fetch(`${endpoint}/capacity`);
            if (resp.ok) {
                const data = await resp.json();
                this.capacityCache[endpoint] = data;
                return data;
            }
        } catch (e) {
            // Ignore - agent might not support /capacity yet
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

    getUsedResourcesPerAgent() {
        // Calculate used CPU shares and memory per agent from running tasks
        const used = {}; // agentId -> {cpu, mem}
        if (!this.status?.tasks_by_agent || !this.jobs) return used;

        // Build job lookup
        const jobMap = {};
        for (const job of this.jobs) {
            jobMap[job.name] = job;
        }

        for (const [agentId, tasks] of Object.entries(this.status.tasks_by_agent)) {
            let cpu = 0, mem = 0;
            for (const t of tasks) {
                if (t.state === 'running') {
                    const job = jobMap[t.job_name];
                    if (job) {
                        cpu += job.cpu_shares || 0;
                        mem += job.memory_limit || 0;
                    }
                }
            }
            used[agentId] = { cpu, mem };
        }
        return used;
    },

    renderAgentsTable() {
        const agentsBody = document.querySelector('#agentsTable tbody');
        if (!this.agents.length) {
            agentsBody.innerHTML = '<tr><td colspan="6" class="empty">No agents</td></tr>';
            return;
        }

        const usedPerAgent = this.getUsedResourcesPerAgent();

        // Sort agents by ID
        const sorted = [...this.agents].sort((a, b) => a.id.localeCompare(b.id));

        agentsBody.innerHTML = sorted.map(a => {
            const cap = this.capacityCache[a.endpoint];
            const used = usedPerAgent[a.id] || { cpu: 0, mem: 0 };

            // CPU: show "used/total" as cores (shares / 1024 = cores)
            let cpuStr = '-';
            if (cap) {
                const usedCores = (used.cpu / 1024).toFixed(1);
                cpuStr = `${usedCores}/${cap.cpu_cores}`;
            }

            // Memory: show "used/total" compact (e.g. "12GB/16GB")
            let memStr = '-';
            if (cap) {
                const usedGB = (used.mem / (1024 * 1024 * 1024)).toFixed(1);
                const totalGB = (cap.memory_bytes / (1024 * 1024 * 1024)).toFixed(0);
                memStr = `${usedGB}GB/${totalGB}GB`;
            }

            return `
                <tr>
                    <td><code>${a.id}</code></td>
                    <td><span class="version">${a.version || 'unknown'}</span></td>
                    <td><code>${a.endpoint}</code></td>
                    <td>${cpuStr}</td>
                    <td>${memStr}</td>
                    <td>${this.formatTime(a.last_seen)}</td>
                </tr>`;
        }).join('');
    },

    async connect() {
        await this.refresh();
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

            // Fetch capacity for new agents (async, don't block)
            for (const a of agents) {
                if (!this.capacityCache[a.endpoint]) {
                    this.fetchAgentCapacity(a.endpoint).then(() => this.renderAgentsTable());
                }
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
                        ${t.state === 'running' ? `<button class="small" onclick="app.openLogs('${t.id}', '${t.agentEndpoint}')">Logs</button>` : '-'}
                    </td>
                </tr>
            `).join('') : '<tr><td colspan="6" class="empty">No tasks</td></tr>';

            document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();

            // Auto-refresh (always on)
            if (!this.refreshInterval) {
                this.refreshInterval = setInterval(() => this.refresh(), 5000);
            }
        } catch (err) {
            document.getElementById('error').innerHTML = `<div class="error">Error: ${err.message}</div>`;
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
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

// Event listeners
document.getElementById('endpoint').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') app.connect();
});

// Close modal on escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') app.closeLogs();
});

// Initial load
app.refresh();
