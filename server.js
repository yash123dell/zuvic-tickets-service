// Environment variables expected: 
// SHOPIFY_ADMIN_TOKEN, SHOPIFY_SHOP, PROXY_SECRET, PROXY_MOUNT (default "/tickets")
// UI_USER, UI_PASS (for Basic auth on admin panel), etc.

import path from 'path';
import fs from 'fs';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import Ticket from './models/Ticket.js';  // Ticket model (e.g., Mongoose schema for support tickets)

// Load environment variables from .env file (if present)
import dotenv from 'dotenv';
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Security: use Helmet to set appropriate HTTP headers (including strict CSP)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // Allow scripts and styles only from self; disallow inline scripts/styles for security
      'script-src': ["'self'"],
      'style-src': ["'self'"]
      // (Add other directives or sources if needed, e.g., for fonts or images)
    }
  }
}));

// Rate limiting to prevent abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100                  // max 100 requests per IP per windowMs
});
app.use(apiLimiter);

// Parse JSON and URL-encoded request bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Basic Authentication middleware for admin panel (if credentials are set in env)
const adminUser = process.env.UI_USER;
const adminPass = process.env.UI_PASS;
const basicAuth = (req, res, next) => {
  if (adminUser && adminPass) {
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="Admin Panel"');
      return res.status(401).send('Authentication required');
    }
    // Decode base64 credentials from "Authorization: Basic <base64(user:pass)>"
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString();
    const [user, pass] = credentials.split(':');
    if (user !== adminUser || pass !== adminPass) {
      res.set('WWW-Authenticate', 'Basic realm="Admin Panel"');
      return res.status(401).send('Authentication required');
    }
  }
  // If no creds required or correct creds provided, proceed
  next();
};

// ** Admin Panel Routes ** //

// Serve Admin Panel HTML (with ticket dashboard UI)
app.get('/admin/panel', basicAuth, (req, res) => {
  const adminPanelPath = path.join(__dirname, 'public', 'admin-panel.html');
  if (fs.existsSync(adminPanelPath)) {
    // Send the admin panel HTML file with correct content type
    // Note: The admin-panel.html should include a <script src="/admin/panel/admin-panel.js"></script> (instead of inline script) to avoid CSP issues
    res.sendFile(adminPanelPath, err => {
      if (err) {
        console.error('Error sending admin panel file:', err);
        res.status(err.status || 500).send('Failed to load admin panel');
      }
    });
  } else {
    res.status(404).send('Admin panel page not found');
  }
});

// Serve supporting script for Admin Panel (to fix CSP inline script issue)
app.get('/admin/panel/admin-panel.js', basicAuth, (req, res) => {
  const scriptPath = path.join(__dirname, 'public', 'admin-panel.js');
  if (fs.existsSync(scriptPath)) {
    res.type('application/javascript');
    res.sendFile(scriptPath);
  } else {
    res.status(404).send('// admin-panel.js not found');
  }
});

// Endpoint to fetch tickets data for the admin UI (supports tab filters)
app.get('/admin/ui/tickets', basicAuth, async (req, res) => {
  try {
    const statusFilter = req.query.status;
    let tickets;
    if (!statusFilter || statusFilter.toLowerCase() === 'all') {
      // No specific status or "All" requested: fetch all tickets
      tickets = await Ticket.find({});  // replace with actual data retrieval logic if needed
    } else {
      // Fetch tickets with the given status (case-insensitive match)
      const statusRegex = new RegExp('^' + statusFilter + '$', 'i');
      tickets = await Ticket.find({ status: statusRegex });
    }
    res.json(tickets);
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// (Additional routes for creating/updating tickets, proxy endpoints, etc., would go here)

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
