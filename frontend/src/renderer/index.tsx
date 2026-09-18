import { createRoot } from 'react-dom/client';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './index.css';
import { App } from './App';
import { installPerfCounters } from './utils/perf';

// Import react-grid-layout styles
import '../../node_modules/react-grid-layout/css/styles.css';
import '../../node_modules/react-resizable/css/styles.css';

// Instrument backend traffic before anything can issue a request. Inert
// unless E2E_TEST is set.
installPerfCounters();

// Create a dedicated container element for the app
const container = document.createElement('div');
container.id = 'root';
document.body.appendChild(container);

// Create the root and render the app
const root = createRoot(container);
root.render(<App />);
