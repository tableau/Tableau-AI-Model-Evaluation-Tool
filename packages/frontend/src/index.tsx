import React from 'react';
import ReactDOM from 'react-dom/client';
import { addDesignTokenStylesToDocument } from '@tableau/tableau-ui';
// Libre Franklin: the open typeface closest to Benton Sans (see index.css).
import '@fontsource/libre-franklin/400.css';
import '@fontsource/libre-franklin/500.css';
import '@fontsource/libre-franklin/600.css';
import './ui/ui.css';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// The Tableau UI library's design tokens, as CSS variables on the document:
// its widgets and the kit's custom pieces (src/ui) read the same values.
addDesignTokenStylesToDocument();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
