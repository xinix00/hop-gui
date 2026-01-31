const app = {
    refreshInterval: null,
    eventSource: null,
    currentTask: null,
    currentStream: 'stdout',
    agents: [],

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

    async connect() {
        await this.refresh();
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

            // Stats
            document.getElementById('agentCount').textContent = status.agents;
            document.getElementById('runningTasks').textContent = status.running_tasks;
            document.getElementById('totalTasks').textContent = status.total_tasks;
            document.getElementById('leaderAddr').textContent = leaderInfo.leader || 'unknown';

            // Agents table
            const agentsBody = document.querySelector('#agentsTable tbody');
            agentsBody.innerHTML = agents.length ? agents.map(a => `
                <tr>
                    <td><code>${a.id}</code></td>
                    <td><code>${a.endpoint}</code></td>
                    <td>${this.formatTime(a.last_seen)}</td>
                </tr>
            `).join('') : '<tr><td colspan="3" class="empty">No agents</td></tr>';

            // Jobs table
            const jobsBody = document.querySelector('#jobsTable tbody');
            jobsBody.innerHTML = jobs.length ? jobs.map(job => `
                <tr>
                    <td><code>${job.id}</code></td>
                    <td>${job.name}</td>
                    <td><code>${this.truncate(job.command, 30)}</code></td>
                    <td>${job.count === -1 ? 'all' : (job.count || 1)}</td>
                    <td><button class="danger small" onclick="app.stopJob('${job.id}')">Stop</button></td>
                </tr>
            `).join('') : '<tr><td colspan="5" class="empty">No jobs</td></tr>';

            // Tasks table (flattened from all agents)
            const tasksBody = document.querySelector('#tasksTable tbody');
            const tasks = [];
            for (const [agentId, agentTasks] of Object.entries(status.tasks_by_agent || {})) {
                const agent = agents.find(a => a.id === agentId);
                for (const t of agentTasks) {
                    tasks.push({ ...t, agentId, agentEndpoint: agent?.endpoint });
                }
            }

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

            // Auto-refresh
            if (document.getElementById('autoRefresh').checked && !this.refreshInterval) {
                this.refreshInterval = setInterval(() => this.refresh(), 5000);
            }
        } catch (err) {
            document.getElementById('error').innerHTML = `<div class="error">Error: ${err.message}</div>`;
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    },

    async stopJob(jobId) {
        if (!confirm(`Stop job ${jobId}?`)) return;
        try {
            await this.fetchAPI(`/v1/jobs/${jobId}`, { method: 'DELETE' });
            this.refresh();
        } catch (err) {
            alert('Failed to stop job: ' + err.message);
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

        this.eventSource.onmessage = (event) => {
            const output = document.getElementById('logOutput');
            output.textContent += event.data;
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
document.getElementById('autoRefresh').addEventListener('change', (e) => {
    if (!e.target.checked) {
        clearInterval(app.refreshInterval);
        app.refreshInterval = null;
    } else {
        app.refresh();
    }
});

document.getElementById('endpoint').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') app.connect();
});

// Close modal on escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') app.closeLogs();
});

// Initial load
app.refresh();
