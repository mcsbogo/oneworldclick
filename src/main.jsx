import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
createRoot(document.getElementById('root')).render(<App />);
