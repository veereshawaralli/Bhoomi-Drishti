/**
 * Entry point.
 *
 * The import order at the top of this file matters and is not alphabetical:
 * Leaflet's own stylesheet has to land *before* `index.css`, because the dark
 * theme overrides Leaflet's default white controls, attribution bar and popup
 * chrome. Load them the other way round and the map arrives wearing its factory
 * light-mode furniture in the middle of a dark command centre.
 *
 * Everything below the router is inside `PlatformProvider`, which owns the one
 * fetch of `/api/info` and `/api/health` that the whole app reads its bands,
 * thresholds, data mode and session from. `AppShell` will not render a single
 * page until that provider has answered once.
 */
import 'leaflet/dist/leaflet.css';
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import { PlatformProvider } from './state/PlatformContext';

const host = document.getElementById('root');
if (!host) {
  // Loud rather than silent: a missing root means index.html was edited and the
  // page would otherwise just sit there blank with no console trace.
  throw new Error('Mount point #root is missing from index.html');
}

createRoot(host).render(
  <StrictMode>
    <BrowserRouter>
      <PlatformProvider>
        <App />
      </PlatformProvider>
    </BrowserRouter>
  </StrictMode>,
);
