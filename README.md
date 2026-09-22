# hop-gui

A static cluster dashboard for Hop, built with the shared Haasstyle components.

## Run

Open `index.html`, or serve this directory:

```sh
python3 -m http.server 3000
```

Open `http://localhost:3000`, choose **Add cluster**, and enter a name, agent address and optional API key. The browser must be able to reach the agent directly, with CORS allowed by the agent. Authenticated requests use Web Crypto, so serve the dashboard on localhost or HTTPS.

No build step, CDN or frontend framework is required. Publish the complete directory, including `vendor/`.

## Dashboard

- Saved clusters, live updates over SSE, agent failover and fallback polling.
- Agent CPU, memory, temperature and task counts.
- Jobs with draggable priority, creation, redeployment and deletion.
- Job details, task status and live stdout/stderr logs.
- Direct links to `#agents`, `#jobs` and `#jobs/<encoded-name>`.
- `?name=NODE&ip=IP` prefills the cluster form without connecting automatically.
- Responsive tables and keyboard-accessible forms, confirmations and dialogs.

## Appearance

Use **Appearance** in the header or **Make it yours** in the footer. Choose these independently:

- Theme: Senior / Classic 95, Medior / Glossy 08, Junior / Tactile Matte.
- Accent colour: purple, red, blue, petrol or green.
- Mode: dark or light.

Glossy 08, purple and dark are the defaults. Appearance is stored as `hop-appearance` in this browser, applied before the stylesheet loads, and synchronized across open tabs. Existing `hop-clusters`, `hop-active-cluster` and endpoint pool settings are retained.

## Maintaining the styles

`style.css` handles Hop's layout. The material, controls, spinner, select and decision dialogs come from `vendor/`; see [vendor/README.md](vendor/README.md). Keep these shared files in sync with Haasstyle instead of recreating their visuals in app-specific CSS.

`appearance.js` manages the picker and theme tokens. `app.js` handles the Hop API and renders the same shared components for dynamic content.

Cluster tabs use the shared `t-tab-*` components: one surface, a horizontal
selection line and a separate integrated close target. Icon actions are at
least 48 × 48 px; tags keep the shared 52 px minimum height. Tables vertically
center text, status labels and actions. Do not override these sizes locally.
