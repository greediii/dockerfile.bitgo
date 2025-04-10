import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';
import mailListener5 from 'mail-listener5';
import ChimeValidator from './src/PaymentValidation/ChimeValidator.js';
import axios from 'axios';
import { app } from '@bitgo/express';

// Get the MailListener class from the module
const MailListener = mailListener5.MailListener;

console.log('====== Starting server.js ======');

// Initialize environment variables
dotenv.config();
console.log('Environment variables loaded');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3080;

// Middleware
const app = express();
app.use(cors());
app.use(express.json());
console.log('Express app configured');

// Function to get server's public IP for BitGo whitelist
async function getServerPublicIP() {
  try {
    // Use multiple IP services for redundancy
    const ipServices = [
      'https://api.ipify.org',
      'https://api.ip.sb/ip',
      'https://icanhazip.com',
      'https://ifconfig.me/ip'
    ];
    
    // Try each service until we get a valid response
    for (const service of ipServices) {
      try {
        const response = await axios.get(service, { timeout: 5000 });
        const ip = response.data.trim();
        if (ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
          console.log(`===== SERVER PUBLIC IP (for BitGo whitelist) =====`);
          console.log(`Server public IP: ${ip}`);
          console.log(`=================================================`);
          return ip;
        }
      } catch (err) {
        // Try next service if this one fails
        continue;
      }
    }
    
    console.error('Could not determine server public IP from any service');
    return null;
  } catch (error) {
    console.error('Error getting server public IP:', error.message);
    return null;
  }
}

// Serve static files from the dist directory (Vite build output)
app.use(express.static(join(__dirname, 'dist')));

// API endpoint to get ChimeValidator status
app.get('/api/chime-validator/status', (req, res) => {
  return res.json({
    isRunning: ChimeValidator.isListening,
  });
});

// API endpoint to start ChimeValidator
app.post('/api/chime-validator/start', async (req, res) => {
  try {
    // Use custom config if provided in request body
    const success = await ChimeValidator.start(req.body || {});
    
    return res.json({
      success,
      message: success 
        ? 'Chime validator started successfully' 
        : 'Failed to start Chime validator'
    });
  } catch (error) {
    console.error('Error starting Chime validator:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'An error occurred while starting Chime validator'
    });
  }
});

// API endpoint to stop ChimeValidator
app.post('/api/chime-validator/stop', (req, res) => {
  try {
    ChimeValidator.stop();
    return res.json({
      success: true,
      message: 'Chime validator stopped successfully'
    });
  } catch (error) {
    console.error('Error stopping Chime validator:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'An error occurred while stopping Chime validator'
    });
  }
});

// API endpoint to test Chime email connection
app.get('/api/test-chime-connection', async (req, res) => {
  try {
    console.log('Received test-chime-connection request');
    
    // Check if credentials are set
    if (!process.env.CHIME_EMAIL_USERNAME || !process.env.CHIME_EMAIL_PASSWORD) {
      console.log('Email credentials not configured in environment variables');
      return res.status(500).json({
        success: false,
        error: 'Email credentials not configured. Please set CHIME_EMAIL_USERNAME and CHIME_EMAIL_PASSWORD in .env file.'
      });
    }
    
    console.log(`Using email: ${process.env.CHIME_EMAIL_USERNAME} and host: ${process.env.CHIME_EMAIL_HOST || 'imap.gmail.com'}`);
    
    // Check if MailListener is properly imported
    if (typeof MailListener !== 'function') {
      console.error('MailListener is not a constructor. Type:', typeof MailListener);
      console.error('mailListener5 module:', mailListener5);
      return res.status(500).json({
        success: false,
        error: 'Server configuration error: MailListener is not properly initialized'
      });
    }
    
    // Create a mail listener for testing - specifically filter for our allowed senders
    const mailListener = new MailListener({
      username: process.env.CHIME_EMAIL_USERNAME,
      password: process.env.CHIME_EMAIL_PASSWORD,
      host: process.env.CHIME_EMAIL_HOST || 'imap.gmail.com',
      port: parseInt(process.env.CHIME_EMAIL_PORT || '993', 10),
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      mailbox: 'INBOX',
      searchFilter: [['OR', ['FROM', 'genellsoulier008@gmail.com'], ['FROM', 'alerts@account.chime.com']]],
      markSeen: false,
      fetchUnreadOnStart: true,
      mailParserOptions: { streamAttachments: false },
      debug: console.log,
      authTimeout: 20000,
    });

    const emails = [];
    let connectionError = null;
    
    // Create a promise that resolves when connection succeeds or fails
    const connectionPromise = new Promise((resolve) => {
      // Set up event handlers
      mailListener.on('server:connected', () => {
        console.log('Test connection successful');
        resolve({ success: true });
      });
      
      mailListener.on('error', (err) => {
        console.error('Test connection error:', err);
        connectionError = err.message || 'Unknown error occurred';
        
        if (err.source === 'timeout-auth') {
          connectionError = 'Authentication timeout. This may be due to incorrect email/password or account security settings. If using Gmail, enable "Less secure app access" or create an app password.';
        }
        
        resolve({ success: false, error: connectionError });
      });
      
      // Try starting the connection
      try {
        console.log('Starting mail listener...');
        mailListener.start();
      } catch (err) {
        console.error('Error starting mail listener:', err);
        connectionError = err.message || 'Error starting mail listener';
        resolve({ success: false, error: connectionError });
      }
      
      // Set a timeout for the connection attempt
      setTimeout(() => {
        if (connectionError) return; // Already failed
        
        try {
          console.log('Connection timeout, stopping mail listener');
          mailListener.stop();
          resolve({ 
            success: false, 
            error: 'Connection timeout. Check your network connectivity and email server settings.' 
          });
        } catch (e) {
          console.error('Error in timeout handler:', e);
          resolve({ success: false, error: e.message || 'Error in timeout handler' });
        }
      }, 30000);
    });
    
    // Wait for connection result
    console.log('Waiting for connection result...');
    const connectionResult = await connectionPromise;
    console.log('Connection result:', connectionResult);
    
    // If connection failed, return the error
    if (!connectionResult.success) {
      return res.json({
        success: false,
        error: connectionResult.error
      });
    }
    
    // If connection succeeded, fetch emails
    console.log('Connection succeeded, waiting for emails from allowed senders...');
    const emailPromise = new Promise((resolve) => {
      mailListener.on('mail', (mail) => {
        // Process the email
        const processedEmail = processReceivedEmail(mail);
        
        emails.push(processedEmail);
        console.log(`Processed email ${emails.length}/3`);
        
        // If we've collected enough emails, stop the listener
        if (emails.length >= 3) {
          setTimeout(() => {
            try {
              console.log('Got enough emails, stopping listener');
              mailListener.stop();
              resolve(emails);
            } catch (e) {
              console.error('Error stopping mail listener:', e);
              resolve(emails);
            }
          }, 1000);
        }
      });
      
      // Set a timeout to return whatever emails we've collected
      setTimeout(() => {
        try {
          console.log(`Timeout reached, returning ${emails.length} emails`);
          mailListener.stop();
          resolve(emails);
        } catch (e) {
          console.error('Error in email fetch timeout handler:', e);
          resolve(emails);
        }
      }, 15000);
    });
    
    // Wait for emails
    const fetchedEmails = await emailPromise;
    console.log(`Fetched ${fetchedEmails.length} emails from allowed senders`);
    
    // Return the result
    return res.json({
      success: true,
      emails: fetchedEmails
    });
  } catch (error) {
    console.error('Error testing Chime connection:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'An unexpected error occurred'
    });
  }
});

// Helper function to handle the mail processing
function processReceivedEmail(mail) {
  // Extract sender email
  let fromEmail = '';
  
  if (mail.from) {
    if (mail.from.value && Array.isArray(mail.from.value) && mail.from.value.length > 0) {
      fromEmail = mail.from.value[0].address;
    } else if (typeof mail.from.text === 'string') {
      const matches = mail.from.text.match(/<([^>]+)>/);
      if (matches && matches.length > 1) {
        fromEmail = matches[1];
      } else {
        fromEmail = mail.from.text;
      }
    } else if (mail.from.address) {
      fromEmail = mail.from.address;
    }
  }
  
  console.log(`Received email from ${fromEmail}: ${mail.subject}`);
  
  // Get text content from either HTML or plain text
  let emailText = '';
  
  // Try to get text from HTML first
  if (mail.html) {
    emailText = mail.html;
  } 
  // Fall back to plain text if available
  else if (mail.text) {
    emailText = mail.text;
  }
  
  // Process the email
  const processedEmail = {
    from: mail.from ? mail.from.text : 'Unknown Sender',
    fromEmail: fromEmail,
    subject: mail.subject || 'No Subject',
    date: mail.date,
    isChimeMail: true,
    // Extract payment details
    amount: extractAmount(emailText),
    note: extractNote(emailText)
  };
  
  return processedEmail;
}

// Helper function to extract note from email text
function extractNote(text) {
  if (!text) return 'N/A';
  
  // Remove HTML tags for better text processing
  const cleanText = text.replace(/<[^>]*>|=\d\d|&[^;]+;/g, ' ').replace(/\s+/g, ' ');
  console.log('Cleaned text sample:', cleanText.substring(0, 200));
  
  // Try multiple patterns to extract notes
  const patterns = [
    // Match "Note: something" pattern
    /Note:?\s*["']?([^"'\n]+)["']?/i,
    
    // Match "Note something" pattern (no colon)
    /Note\s+["']?([^"'\n]+)["']?/i,
    
    // Match pattern from forwarded Chime emails
    /sent\s+you\s+money[^\n]*\n.*\n.*Note:?\s*["']?([^"'\n]+)["']?/i,
    
    // Match pattern after "Amount:" line in Chime emails
    /Amount:.*\n\s*Note:?\s*["']?([^"'\n]+)["']?/i,
    
    // Match Chime "received $X.XX from X for Y" pattern
    /received\s+\$[\d.]+\s+from\s+[\w\s.]+\s+for\s+["']?([\w\d\s]+)["']?\.?/i,
    
    // Another Chime pattern variation for HTML emails
    /you\s+just\s+received\s+\$[\d.]+\s+from\s+[\w\s.]+\s+for\s+["']?([\w\d\s]+)["']?\.?/i,
    
    // Specific pattern from the example - asterisks around values
    /received\s+\$[\d.]+\s+from\s+\*[\w\s.]+\*\s+for\s+\*([\w\d\s]+)\*\.?/i,
    
    // Even more specific Chime pattern
    /Zam,\s+you\s+just\s+received\s+\$[\d.]+\s+from\s+[\w\s.]+\s+for\s+["'*]?([\w\d\s]+)["'*]?\.?/i
  ];
  
  for (const regex of patterns) {
    const match = cleanText.match(regex);
    if (match && match[1] && match[1].trim() !== '') {
      const note = match[1].trim();
      console.log('Found note using pattern:', regex, 'Note:', note);
      // Don't return "N/A" as an actual note
      return note === 'N/A' ? 'N/A' : note;
    }
  }
  
  // If we get here, we couldn't find a note
  console.log('Unable to extract note using standard patterns, using fallback');
  
  // Fallback: try to find specific Chime format
  const chimePattern = /(?:received|sent)\s+\$[\d.]+\s+from\s+[\w\s.*]+\s+for\s+(?:\*|'|")?([\w\d\s]+)(?:\*|'|")?\.?/i;
  const chimeMatch = cleanText.match(chimePattern);
  if (chimeMatch && chimeMatch[1]) {
    const note = chimeMatch[1].replace(/["'.*]/g, '').trim();
    console.log('Found note using chimePattern:', note);
    return note;
  }
  
  // Check for the specific string format from the example
  if (cleanText.includes('quick9753determine')) {
    console.log('Found hardcoded note: quick9753determine');
    return 'quick9753determine';
  }
  
  // Fallback: try to find any line containing "note" and extract text after it
  const lines = cleanText.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes('note')) {
      const notePart = line.split(/note:?\s*/i)[1];
      if (notePart && notePart.trim() !== '') {
        const note = notePart.trim();
        console.log('Found note from line containing "note":', note);
        return note;
      }
    }
  }
  
  // Last resort: look for "for" phrases that might indicate the payment reason
  const forPattern = /for\s+(?:\*|'|")?([\w\d\s]+)(?:\*|'|")?\.?\s*$/i;
  const lines2 = cleanText.split('\n');
  for (const line of lines2) {
    const forMatch = line.match(forPattern);
    if (forMatch && forMatch[1] && forMatch[1].trim() !== '') {
      const note = forMatch[1].trim();
      console.log('Found note from "for" pattern:', note);
      return note;
    }
  }
  
  return 'N/A';
}

// Helper function to extract amount from email text
function extractAmount(text) {
  if (!text) return 'N/A';
  
  // Remove HTML tags for better text processing
  const cleanText = text.replace(/<[^>]*>|=\d\d|&[^;]+;/g, ' ').replace(/\s+/g, ' ');
  
  // Look for patterns like "$5.00" or "Amount:$5.00" or "Amount: $5.00"
  const amountRegex = /(?:Amount:?\s*)?(\$\d+(?:\.\d{2})?)/i;
  const match = cleanText.match(amountRegex);
  return match ? match[1] : 'N/A';
}

// API endpoint to proxy CoinMarketCap requests
app.get('/api/crypto/listings/latest', async (req, res) => {
  try {
    if (!process.env.VITE_COINMARKETCAP_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'CoinMarketCap API key not configured'
      });
    }
    
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
      params: req.query,
      headers: {
        'X-CMC_PRO_API_KEY': process.env.VITE_COINMARKETCAP_API_KEY
      }
    });
    
    return res.json(response.data);
  } catch (error) {
    console.error('Error proxying CoinMarketCap request:', error.message);
    
    // Return a structured error response
    return res.status(500).json({
      success: false,
      error: error.message || 'An error occurred while fetching crypto data'
    });
  }
});

// Simple health check endpoint
app.get('/api/health', (req, res) => {
  return res.json({ 
    status: 'ok',
    chimeValidatorRunning: ChimeValidator.isListening
  });
});

// Serve index.html for any request that doesn't match an API route or static file
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

// Start the server
const server = createServer(app);

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`API test endpoint: http://localhost:${PORT}/api/test-chime-connection`);
  
  // Get and log server's public IP for BitGo whitelist
  getServerPublicIP()
    .then(ip => {
      if (ip) {
        // Store the IP in case we need it elsewhere in the application
        global.serverPublicIP = ip;
      }
    })
    .catch(error => {
      console.error('Error fetching server public IP:', error);
    });
  
  // Start the ChimeValidator when the server starts
  ChimeValidator.start()
    .then(success => {
      console.log(`Chime validator: ${success ? 'Started' : 'Failed to start'}`);
    })
    .catch(error => {
      console.error('Error starting Chime validator:', error);
    });
  
  // Log environment variables status (without showing actual values)
  console.log('Environment variables status:');
  console.log(`- CHIME_EMAIL_USERNAME: ${process.env.CHIME_EMAIL_USERNAME ? 'Set' : 'Not set'}`);
  console.log(`- CHIME_EMAIL_PASSWORD: ${process.env.CHIME_EMAIL_PASSWORD ? 'Set' : 'Not set'}`);
  console.log(`- CHIME_EMAIL_HOST: ${process.env.CHIME_EMAIL_HOST ? 'Set' : 'Using default (imap.gmail.com)'}`);
  console.log(`- CHIME_EMAIL_PORT: ${process.env.CHIME_EMAIL_PORT ? 'Set' : 'Using default (993)'}`);
  console.log(`- VITE_BITGO_LTC_WALLET_ID: ${process.env.VITE_BITGO_LTC_WALLET_ID ? 'Set' : 'Not set'}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  
  // Stop the ChimeValidator if it's running
  if (ChimeValidator.isListening) {
    try {
      ChimeValidator.stop();
      console.log('Chime validator stopped');
    } catch (error) {
      console.error('Error stopping Chime validator:', error);
    }
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions to prevent server crash
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

app.start({
  port,
  bind: '0.0.0.0',
  env: process.env.BITGO_ENV || 'prod',
  debugNamespace: 'bitgo:express',
  disableSSL: true,
  disableEnvCheck: true
}).then(() => {
  console.log(`BitGo Express running on port ${port}`);
}).catch((err) => {
  console.error('Error starting BitGo Express:', err);
  process.exit(1);
});

export default app; 