# easyrun-gui

Simple web dashboard for easyrun.

## Usage

Just open `index.html` in your browser, enter an agent address, and click Connect.

```bash
# Or serve it
python3 -m http.server 3000
# Then open http://localhost:3000
```

## Features

- View cluster status (agents, tasks)
- View all jobs
- Stop jobs
- Auto-refresh every 5 seconds

## Note

For CORS to work, the browser needs to be able to reach the easyrun agent directly.
