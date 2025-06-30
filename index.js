const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
require('dotenv').config();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

console.log('Attempting to connect to MongoDB with URI:', process.env.MONGODB_URI);

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS:3600000,
})

.then(() => console.log('MongoDB connected successfully!'))
.catch(err => {
    console.error('MongoDB connection error:', err);
});

const accountSchema = new mongoose.Schema({
  phoneNumber: String,
  stringSession: String,
  username: String,
  createdAt: { type: Date, default: Date.now },
});

const PendingClient = new Map();
const Account = mongoose.model('Account', accountSchema);

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

app.get('/api/accounts', async (req, res) => {
  const accounts = await Account.find();
  res.json(accounts);
});

app.post('/api/send-code', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return res.status(400).json({ success: false, message: 'Phone number is required.' });
  }

  try {
    const stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

    await client.connect();

    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phoneNumber,
        apiId: apiId,
        apiHash: apiHash,
        settings: new Api.CodeSettings({}),
      })
    );

    PendingClient.set(phoneNumber, {
      client,
      session: stringSession,
      phoneCodeHash: result.phoneCodeHash,
    });

    console.log(`[INFO] Code sent to ${phoneNumber}`);
    res.json({ success: true, message: 'Code sent successfully.' });

  } catch (err) {
    if (err.errorMessage && err.errorMessage.includes('A wait of')) {
      const waitMatch = err.errorMessage.match(/A wait of (\\d+) seconds/);
      const waitTime = waitMatch ? parseInt(waitMatch[1]) : null;
      return res.status(429).json({
        success: false,
        message: waitTime
          ? `Rate limited. Please wait ${Math.ceil(waitTime / 60)} minutes.`
          : 'Rate limited by Telegram. Try again later.'
      });
    }

    console.error('[ERROR] Failed to send code:', err);
    res.status(500).json({ success: false, message: 'Failed to send code.' });
  }
});

app.post('/api/verify-code', async (req, res) => {
  const { phoneNumber, code, password } = req.body;
  const pending = PendingClient.get(phoneNumber);
  if (!pending) return res.status(400).json({ success: false, message: 'No pending client found.' });
  const { client } = pending;

  try {
    await client.start({
      phoneNumber: async () => phoneNumber,
      phoneCode: async () => code,
      password: async () => password || '',
      onError: (err) => console.log(err),
    });

    const session = client.session.save();
    const me = await client.getMe();
    const account = new Account({
      phoneNumber,
      stringSession: session,
      username: me.username || '',
    });
    await account.save();

    PendingClient.delete(phoneNumber);
    res.json({ success: true, message: 'Account verified and saved.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Verification failed.' });
  }
});


// Remove account and leave channel if provided
app.delete('/api/accounts/:id', async (req, res) => {
  const { id } = req.params;
  const { channelLink, phoneNumber } = req.body;

  try {
    const account = await Account.findById(id);
    if (!account) return res.status(404).json({ success: false, message: 'Account not found' });

    // Leave the channel before deletion (if channel link is given)
    if (channelLink && channelLink.trim()) {
      const client = new TelegramClient(new StringSession(account.stringSession), apiId, apiHash, { connectionRetries: 3 });
      await client.connect();

      try {
        let inputChannel;
        const link = channelLink.trim();

        if (link.includes('joinchat') || link.includes('+')) {
          const inviteHash = link.split('/').pop().replace('+', '');
          const imported = await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
          const entity = imported.chats[0];
          inputChannel = await client.getInputEntity(entity);
        } else {
          const username = link
            .replace('https://t.me/', '')
            .replace('http://t.me/', '')
            .replace('t.me/', '')
            .replace('@', '')
            .trim();
          inputChannel = await client.getInputEntity(username);
        }

        await client.invoke(new Api.channels.LeaveChannel({ channel: inputChannel }));
        console.log(`${account.phoneNumber} left ${channelLink}`);
      } catch (err) {
        console.error(`Leave error: ${phoneNumber}:`, err.message);
        // Still proceed to remove from DB
      }

      await client.disconnect();
    }

    // Remove from DB
    await Account.findByIdAndDelete(id);

    res.json({ success: true, message: 'Account removed and left channel if joined.' });
  } catch (err) {
    console.error('Delete error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

   
// Join Channel Route 

// Helper: Timeout wrapper
function withTimeout(promise, ms, errorMessage = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMessage)), ms)),
  ]);
}

// Suppress unhandled timeout error logs from updates.js
process.on('unhandledRejection', (reason) => {
  if (reason && reason.message && reason.message.includes('TIMEOUT')) {
    console.warn('[Suppressed TIMEOUT warning]', reason.message);
  } else {
    console.error('Unhandled Rejection:', reason);
  }
});

// Route to join a channel
app.post('/api/join-channel', async (req, res) => {
  const { channelLink, numberOfAccounts, joinDelayMinutes, stayDays } = req.body;

  const accounts = await Account.find().limit(Number(numberOfAccounts));
  if (!accounts.length) {
    return res.status(400).json({ success: false, message: 'No accounts available.' });
  }

  res.json({ success: true, message: 'Join process started.' });

  accounts.forEach((acc, index) => {
    setTimeout(async () => {
      let client;
      try {
        console.log(`Processing ${acc.phoneNumber}...`);

        client = new TelegramClient(
          new StringSession(acc.stringSession),
          apiId,
          apiHash,
          { connectionRetries: 3 }
        );

        await withTimeout(client.connect(), 15000, 'Connection timeout');

        const link = channelLink.trim();
        let inputChannel;

        if (link.includes('joinchat') || link.includes('+')) {
          const inviteHash = link.split('/').pop().replace('+', '');
          try {
            const imported = await withTimeout(
              client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash })),
              15000,
              'ImportChatInvite timeout'
            );
            inputChannel = await client.getInputEntity(imported.chats[0]);
          } catch (err) {
            if (err.message.includes('USER_ALREADY_PARTICIPANT')) {
              console.log(`${acc.phoneNumber} is already in the channel. Skipping join.`);
              inputChannel = await client.getInputEntity(channelLink);
            } else {
              throw err;
            }
          }
        } else {
          const username = link
            .replace('https://t.me/', '')
            .replace('http://t.me/', '')
            .replace('t.me/', '')
            .replace('@', '')
            .trim();

          inputChannel = await withTimeout(
            client.getInputEntity(username),
            15000,
            'GetEntity timeout'
          );
        }

        await withTimeout(
          client.invoke(new Api.channels.JoinChannel({ channel: inputChannel })),
          15000,
          'JoinChannel timeout'
        );

        // Make the channel visible in the app
        try {
          await client.getMessages(inputChannel, { limit: 1 });
          await client.invoke(new Api.messages.ReadHistory({ peer: inputChannel }));
        } catch (readErr) {
          console.warn(`[${acc.phoneNumber}] ReadHistory skipped due to:`, readErr.message);
        }

        const joinedEntity = await client.getEntity(inputChannel);
        console.log(`${acc.phoneNumber} joined channel: ${joinedEntity.title}`);

        const leaveDelay = Number(stayDays) * 60 * 1000;

        setTimeout(() => {
  const leaveClient = new TelegramClient(
    new StringSession(acc.stringSession),
    apiId,
    apiHash,
    { connectionRetries: 3 }
  );

  (async () => {
    try {
      await withTimeout(leaveClient.connect(), 15000, 'Reconnect timeout');

      // Use full entity to avoid PeerUser/ID mismatch
      const leaveChannelEntity = await leaveClient.getInputEntity(joinedEntity);

      await withTimeout(
        leaveClient.invoke(new Api.channels.LeaveChannel({ channel: leaveChannelEntity })),
        15000,
        'LeaveChannel timeout'
      );

      console.log(`${acc.phoneNumber} left channel: ${joinedEntity.title}`);
    } catch (leaveErr) {
      console.error(`${acc.phoneNumber} leave process error:`, leaveErr.message);
    } finally {
      await leaveClient.disconnect();
    }
  })();
}, leaveDelay);


        await client.disconnect();

      } catch (err) {
        if (!err.message.includes('TIMEOUT')) {
          console.error(`Error (${acc.phoneNumber}):`, err.message);
        }
        if (client) await client.disconnect();
      }
    }, index * Number(joinDelayMinutes) * 60 * 1000);
  });
});





app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(3000, () => console.log('Server started on port 3000'));
