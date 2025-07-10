const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
require('dotenv').config();
const path = require('path');
const moment = require('moment');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

console.log('Attempting to connect to MongoDB with URI:', process.env.MONGODB_URI);

mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 3000, // Timeout after 3s if server not found
})
.then(() => console.log('MongoDB connected successfully!'))
.catch(err => {
    console.error('MongoDB connection error:', err);
    // Exit process if MongoDB connection fails critical early
    process.exit(1);
});

// --- Mongoose Schema and Model ---
const accountSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true }, // Add unique constraint for phone number
    stringSession: { type: String, required: true },
    username: String,
    createdAt: { type: Date, default: Date.now },
});

const PendingClient = new Map(); // Stores client sessions for OTP verification
const Account = mongoose.model('Account', accountSchema);

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;

// --- GLOBAL UTILITIES / HELPERS (DEFINED BEFORE ROUTES) ---

// Helper: Timeout wrapper for Telegram API calls
function withTimeout(promise, ms, errorMessage = 'Operation timed out') {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(errorMessage)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// Suppress unhandled timeout error logs from updates.js to reduce noise
process.on('unhandledRejection', (reason) => {
    if (reason && reason.message && reason.message.includes('TIMEOUT')) {
        console.warn('[Suppressed TIMEOUT warning]', reason.message);
    } else {
        console.error('Unhandled Rejection (likely from Telegram client):', reason);
    }
});

/**
 * Helper function to get Telegram InputPeer entity from a channel link, username, or invite hash.
 * This is crucial for interacting with channels programmatically.
 * @param {TelegramClient} client - The connected TelegramClient instance.
 * @param {string} channelLink - The link (t.me/username, t.me/joinchat/+hash) or username of the channel.
 * @returns {Promise<Api.TypeInputPeer>} The InputPeer entity for the channel.
 * @throws {Error} If the channel cannot be resolved or the link is invalid.
 */
async function getChannelEntity(client, channelLinkOrId) {
    const link = String(channelLinkOrId).trim();

    // If it's a numeric ID, treat as channel ID
    if (/^-?\d+$/.test(link)) {
        // Try to resolve as channel ID
        try {
            
            return await client.getInputEntity(Number(link));
        } catch (idErr) {
            throw new Error(`Could not resolve channel from ID: ${link} (${idErr.message})`);
        }
    }

    // If it's a username (starts with @ or is just a word)
    if (link.startsWith('@') || /^[a-zA-Z0-9_]{5,}$/.test(link)) {
        const username = link.replace('@', '').trim();
        try {
            return await client.getInputEntity(username);
        } catch (userErr) {
            throw new Error(`Could not resolve channel from username: @${username} (${userErr.message})`);
        }
    }

    // If it's a join link (joinchat/+hash)
    if (link.includes('joinchat') || link.includes('+')) {
  try {
    // Try directly resolving the link — works if already joined
    return await client.getInputEntity(link);
  } catch (resolveErr) {
    const inviteHash = link.split('/').pop().replace('+', '');
    try {
      const checkedInvite = await client.invoke(
        new Api.messages.CheckChatInvite({ hash: inviteHash })
      );

      if (checkedInvite instanceof Api.ChatInvite) {
        // Not a participant — cannot mute/unmute
        throw new Error(`Invite valid, but account has not joined the channel.`);
      }

      return await client.getInputEntity(checkedInvite.chat || checkedInvite.channel);
    } catch (checkErr) {
      throw new Error(`Could not resolve channel from invite link: ${link}`);
    }
  }
}


    // If it's a t.me/username link
    if (link.startsWith('https://t.me/') || link.startsWith('http://t.me/') || link.startsWith('t.me/')) {
        const username = link
            .replace('https://t.me/', '')
            .replace('http://t.me/', '')
            .replace('t.me/', '')
            .replace('@', '')
            .trim();
        try {
            return await client.getInputEntity(username);
        } catch (userErr) {
            throw new Error(`Could not resolve channel from username: @${username} (${userErr.message})`);
        }
    }

    throw new Error('Invalid channel identifier. Please provide a valid channel ID, username, or invite link.');
}

// --- API ROUTES ---

// Route to get all registered accounts
app.get('/api/accounts', async (req, res) => {
    try {
        const accounts = await Account.find({});
        res.json(accounts);
    } catch (error) {
        console.error('Error fetching accounts:', error);
        res.status(500).json({ success: false, message: 'Failed to retrieve accounts.' });
    }
});

// Route to send OTP code to a phone number
app.post('/api/send-code', async (req, res) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber || typeof phoneNumber !== 'string') {
        return res.status(400).json({ success: false, message: 'Phone number is required.' });
    }

    // Check if account already exists in DB
    try {
        const existingAccount = await Account.findOne({ phoneNumber: phoneNumber });
        if (existingAccount) {
            return res.status(409).json({ success: false, message: 'This phone number is already registered.' });
        }
    } catch (dbError) {
        console.error('Database error checking existing account:', dbError);
        return res.status(500).json({ success: false, message: 'Internal server error during account check.' });
    }

    let client;
    try {
        const stringSession = new StringSession('');
        client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

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
            session: stringSession, // Store the session for later use
            phoneCodeHash: result.phoneCodeHash,
        });

        console.log(`[INFO] Code sent to ${phoneNumber}`);
        res.json({ success: true, message: 'Code sent successfully.' });

    } catch (err) {
        if (err.errorMessage && err.errorMessage.includes('A wait of')) {
            const waitMatch = err.errorMessage.match(/A wait of (\d+) seconds/); // Corrected regex for digits
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
    } finally {
        
    }
});

// Route to verify OTP/password and save account
app.post('/api/verify-code', async (req, res) => {
    const { phoneNumber, code, password } = req.body;
    const pending = PendingClient.get(phoneNumber);

    if (!pending) {
        return res.status(400).json({ success: false, message: 'No pending client found for this phone number. Please send code first.' });
    }

    const { client, session, phoneCodeHash } = pending; // Destructure session and phoneCodeHash

    try {
        await client.start({
            phoneNumber: async () => phoneNumber,
            phoneCode: async () => code,
            password: async () => {
                if (password) return password;
                throw new Error('PASSWORD_REQUIRED'); // Custom error for 2FA
            },
            phoneCodeHash: phoneCodeHash, // Pass phoneCodeHash received from sendCode
            onError: (err) => {
                console.error('Telegram client start error:', err);
                // Allow the outer catch block to handle this
            },
        });

        const stringSession = client.session.save(); // Save the new session after successful login
        const me = await client.getMe(); // Get user info

        const account = new Account({
            phoneNumber,
            stringSession: stringSession, // Use the new session string
            username: me.username || '',
        });
        await account.save();

        PendingClient.delete(phoneNumber); // Clear pending client after successful login
        res.json({ success: true, message: 'Account verified and saved successfully.' });
    } catch (error) {
        console.error('Verification error:', error);
        if (error.message === 'PASSWORD_REQUIRED' || (error.errorMessage && error.errorMessage.toLowerCase().includes('password'))) {
            return res.status(401).json({ success: false, message: 'Password required for 2-step verification. Please provide it.' });
        } else if (error.errorMessage && error.errorMessage.includes('PHONE_CODE_INVALID')) {
            return res.status(400).json({ success: false, message: 'Invalid phone code. Please try again.' });
        } else if (error.errorMessage && error.errorMessage.includes('PHONE_CODE_EXPIRED')) {
            return res.status(400).json({ success: false, message: 'Phone code expired. Please request a new one.' });
        }
        res.status(500).json({ success: false, message: `Verification failed: ${error.message || 'Unknown error'}` });
    } finally {
        if (client && client.connected) {
            await client.disconnect(); // Disconnect client after verification attempt
        }
    }
});

// Route to remove an account
app.delete('/api/accounts/:id', async (req, res) => {
    const { id } = req.params;
    const { channelLink } = req.body; // Optional: for leaving a channel before deletion

    let client;
    try {
        const account = await Account.findById(id);
        if (!account) {
            return res.status(404).json({ success: false, message: 'Account not found.' });
        }

        // Leave the channel before deletion if a channelLink is provided
        if (channelLink && channelLink.trim()) {
            try {
                client = new TelegramClient(new StringSession(account.stringSession), apiId, apiHash, { connectionRetries: 3 });
                await withTimeout(client.connect(), 10000, `Client connect timeout for leave operation (${account.phoneNumber})`);

                const inputChannel = await withTimeout(
                    getChannelEntity(client, channelLink),
                    10000,
                    `Get channel entity timeout for leave operation (${account.phoneNumber})`
                );

                await withTimeout(
                    client.invoke(new Api.channels.LeaveChannel({ channel: inputChannel })),
                    15000,
                    `LeaveChannel timeout for ${account.phoneNumber}`
                );
                console.log(`${account.phoneNumber} successfully left ${channelLink} before deletion.`);
            } catch (leaveErr) {
                console.error(`Warning: Failed to leave channel for ${account.phoneNumber} (ID: ${id}):`, leaveErr.message);
                // Log the error but continue to delete the account from DB
            } finally {
                if (client && client.connected) {
                    await client.disconnect();
                }
            }
        }

        // Remove the account from the database
        await Account.findByIdAndDelete(id);
        res.json({ success: true, message: 'Account removed successfully.' });

    } catch (err) {
        console.error('Error removing account (ID:', id, '):', err.message);
        res.status(500).json({ success: false, message: `Failed to remove account: ${err.message}` });
    }
});

// Route to join a channel
app.post('/api/join-channel', async (req, res) => {
    const { channelLink, numberOfAccounts, joinDelayMinutes, stayDays } = req.body;

    const accounts = await Account.find().limit(Number(numberOfAccounts));
    if (!accounts.length) {
        return res.status(400).json({ success: false, message: 'No accounts available to join channels.' });
    }

    res.json({ success: true, message: 'Join process initiated.' });

    accounts.forEach((acc, index) => {
        const delayMs = index * Number(joinDelayMinutes) * 60 * 1000;
        setTimeout(async () => {
            let client;
            try {
                console.log(`[JOIN] Processing ${acc.phoneNumber}...`);

                client = new TelegramClient(
                    new StringSession(acc.stringSession),
                    apiId,
                    apiHash,
                    { connectionRetries: 3 }
                );

                await withTimeout(client.connect(), 15000, `Connection timeout for ${acc.phoneNumber}`);

                const link = channelLink.trim();
                let inputChannel;
                let joinedEntityTitle = 'Unknown Channel'; // Default for logging

                if (link.includes('joinchat') || link.includes('+')) {
                    const inviteHash = link.split('/').pop().replace('+', '');
                    try {
                        const imported = await withTimeout(
                            client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash })),
                            20000, // Increased timeout for import
                            `ImportChatInvite timeout for ${acc.phoneNumber}`
                        );
                        
                        if (imported.chats && imported.chats.length > 0) {
                             inputChannel = await client.getInputEntity(imported.chats[0]);
                             joinedEntityTitle = imported.chats[0].title || 'Private Channel';
                        } else if (imported.updates && imported.updates.length > 0) {
                            // Sometimes updates contain the new peer
                            const newPeer = imported.updates.find(u => u.className === 'UpdateNewChannel' || u.className === 'UpdateNewChat');
                            if (newPeer && newPeer.channel) {
                                inputChannel = await client.getInputEntity(newPeer.channel);
                                joinedEntityTitle = newPeer.channel.title || 'Private Channel';
                            } else if (newPeer && newPeer.chat) {
                                inputChannel = await client.getInputEntity(newPeer.chat);
                                joinedEntityTitle = newPeer.chat.title || 'Private Chat';
                            } else {
                                throw new Error('Could not find chat/channel entity after import.');
                            }
                        } else {
                            throw new Error('ImportChatInvite returned no usable chat/channel entity.');
                        }

                    } catch (err) {
                        if (err.errorMessage && err.errorMessage.includes('USER_ALREADY_PARTICIPANT')) {
                            console.log(`[JOIN - ${acc.phoneNumber}] Already in channel: ${link}. Skipping join.`);
                            // If already a participant, try to get the entity directly
                            try {
                                inputChannel = await withTimeout(getChannelEntity(client, link), 10000, `Get existing entity timeout for ${acc.phoneNumber}`);
                                const existingEntity = await client.getEntity(inputChannel);
                                joinedEntityTitle = existingEntity.title || 'Private Channel';
                            } catch (getEntityErr) {
                                console.error(`[JOIN - ${acc.phoneNumber}] Failed to get existing channel entity:`, getEntityErr.message);
                                throw new Error(`Already in channel but failed to resolve entity: ${getEntityErr.message}`);
                            }
                        } else {
                            throw err; // Re-throw other errors
                        }
                    }
                } else {
                    // Use the helper for public channels/usernames
                    inputChannel = await withTimeout(
                        getChannelEntity(client, channelLink),
                        15000,
                        `GetEntity timeout for ${acc.phoneNumber}`
                    );
                    const publicEntity = await client.getEntity(inputChannel);
                    joinedEntityTitle = publicEntity.title || 'Public Channel';
                }

                // If inputChannel is still not defined at this point, something went wrong
                if (!inputChannel) {
                    throw new Error('Failed to obtain a valid channel entity for joining.');
                }

                // Attempt to join the channel
                try {
                    await withTimeout(
                        client.invoke(new Api.channels.JoinChannel({ channel: inputChannel })),
                        15000,
                        `JoinChannel timeout for ${acc.phoneNumber}`
                    );
                    console.log(`[JOIN - ${acc.phoneNumber}] Successfully joined channel: ${joinedEntityTitle}`);
                    // After joining, fetch and log the channel's username or ID for future reference
                    try {
                        const joinedEntity = await client.getEntity(inputChannel);
                        if (joinedEntity.username) {
                            console.log(`[JOIN - ${acc.phoneNumber}] Channel username: @${joinedEntity.username} (use this for future membership checks)`);
                        } else if (joinedEntity.id) {
                            console.log(`[JOIN - ${acc.phoneNumber}] Channel ID: ${joinedEntity.id} (use this for future membership checks)`);
                        }
                    } catch (entityLogErr) {
                        console.warn(`[JOIN - ${acc.phoneNumber}] Could not fetch channel username/ID:`, entityLogErr.message);
                    }
                } catch (joinErr) {
                    if (joinErr.errorMessage && joinErr.errorMessage.includes('USER_ALREADY_PARTICIPANT')) {
                        console.log(`[JOIN - ${acc.phoneNumber}] Confirmed already participant in ${joinedEntityTitle}.`);
                    } else {
                        throw joinErr; // Re-throw other join errors
                    }
                }


                // Make the channel visible in the app
                try {
                    await client.getMessages(inputChannel, { limit: 1 });
                    await client.invoke(new Api.messages.ReadHistory({ peer: inputChannel }));
                    console.log(`[JOIN - ${acc.phoneNumber}] Made ${joinedEntityTitle} visible.`);
                } catch (readErr) {
                    console.warn(`[JOIN - ${acc.phoneNumber}] ReadHistory skipped for ${joinedEntityTitle} due to:`, readErr.message);
                }

                const leaveDelay = Number(stayDays) * 2 * 60 * 1000;

                if (leaveDelay > 0) { // Only schedule leave if stayDays is meaningful
                    setTimeout(() => {
                        const leaveClient = new TelegramClient(
                            new StringSession(acc.stringSession),
                            apiId,
                            apiHash,
                            { connectionRetries: 3 }
                        );

                        (async () => {
                            try {
                                await withTimeout(leaveClient.connect(), 15000, `Reconnect timeout for leave (${acc.phoneNumber})`);
                                const leaveChannelEntity = await leaveClient.getInputEntity(inputChannel); // Use inputChannel directly here
                                await withTimeout(
                                    leaveClient.invoke(new Api.channels.LeaveChannel({ channel: leaveChannelEntity })),
                                    15000,
                                    `LeaveChannel timeout for ${acc.phoneNumber}`
                                );
                                console.log(`[LEAVE - ${acc.phoneNumber}] Successfully left channel: ${joinedEntityTitle}`);
                            } catch (leaveErr) {
                                console.error(`[LEAVE - ${acc.phoneNumber}] Error leaving ${joinedEntityTitle}:`, leaveErr.message);
                            } finally {
                                if (leaveClient && leaveClient.connected) {
                                    await leaveClient.disconnect();
                                }
                            }
                        })();
                    }, leaveDelay);
                } else {
                     console.log(`[JOIN - ${acc.phoneNumber}] No leave scheduled for ${joinedEntityTitle} (stayDays set to 0).`);
                }

            } catch (err) {
                console.error(`[JOIN - ${acc.phoneNumber}] Overall error during join process for ${channelLink}:`, err.message);
                if (err.errorMessage && err.errorMessage.includes('USER_ALREADY_PARTICIPANT')) {
                    console.log(`[JOIN - ${acc.phoneNumber}] This account was already a participant.`);
                }
            } finally {
                if (client && client.connected) {
                    await client.disconnect(); // Ensure client disconnects after join attempt
                }
            }
        }, delayMs);
    });
});


//Leave a channel

app.post('/api/leave-channel', async (req, res) => {
  const { channelLink, count, intervalMinutes } = req.body;

  try {
    const allAccounts = await Account.find();
    const joinedAccounts = [];

    for (const acc of allAccounts) {
      const client = new TelegramClient(new StringSession(acc.stringSession), apiId, apiHash, { connectionRetries: 3 });
      try {
        await client.connect();
        const inputChannel = await getChannelEntity(client, channelLink);

        // Check if account is already a member
        await client.invoke(new Api.channels.GetParticipant({
          channel: inputChannel,
          participant: 'me'
        }));

        // If no error, it's joined
        joinedAccounts.push({ acc, inputChannel });
      } catch (err) {
        if (err.errorMessage?.includes('USER_NOT_PARTICIPANT')) {
          // Not in channel, skip
        } else {
          console.warn(`[${acc.phoneNumber}] check failed:`, err.message);
        }
      } finally {
        await client.disconnect();
      }
    }

   const selectedAccounts = joinedAccounts.slice(0, count);
const intervalMs = intervalMinutes * 60 * 1000;

selectedAccounts.forEach(({ acc, inputChannel }, index) => {
  const delay = index * intervalMs;

  setTimeout(() => {
    (async () => {
      const client = new TelegramClient(
        new StringSession(acc.stringSession),
        apiId,
        apiHash,
        { connectionRetries: 3 }
      );

      try {
        await client.connect();
        await client.invoke(new Api.channels.LeaveChannel({ channel: inputChannel }));
        console.log(`[LEAVE] ${acc.phoneNumber} left the channel at T+${index * intervalMinutes} minutes`);
      } catch (err) {
        console.error(`[LEAVE ERROR] ${acc.phoneNumber}:`, err.message);
      } finally {
        await client.disconnect();
      }
    })(); // Immediately invoked async function
  }, delay);
});



    res.json({ success: true, message: `Scheduled ${selectedAccounts.length} accounts to leave at ${intervalMinutes} min intervals.` });


  } catch (err) {
    console.error('Leave channel error:', err.message);
    res.status(500).json({ success: false, message: 'Server error while processing leave channel.' });
  }
});


//  mute/unmute accounts in a channel
app.post('/api/mute-unmute', async (req, res) => {
  const { channelLink, action, duration, count } = req.body;

  try {
    const accounts = await Account.find().limit(Number(count));
    if (!accounts.length) {
      return res.status(400).json({ success: false, message: 'No accounts available.' });
    }

    accounts.forEach(async (acc, index) => {
      let client;
      try {
        client = new TelegramClient(new StringSession(acc.stringSession), apiId, apiHash, { connectionRetries: 3 });
        await client.connect();

        const inputChannel = await getChannelEntity(client, channelLink);
        
        // MuteUntil: 0 for unmute, or timestamp in future for mute
        const muteUntil = action === 'mute'
          ? Math.floor(Date.now() / 1000) + (duration * 60)  // duration in minutes
          : 0;

       await client.invoke(new Api.account.UpdateNotifySettings({
  peer: inputChannel,
  settings: new Api.InputPeerNotifySettings({
    muteUntil
  })
}));

console.log(`[${acc.phoneNumber}] ${action.toUpperCase()} applied.`);

// If action is "mute", schedule auto-unmute
if (action === 'mute' && duration > 0) {
  const unmuteDelay = duration * 1 * 1000;

  setTimeout(async () => {
    const unmuteClient = new TelegramClient(
      new StringSession(acc.stringSession),
      apiId,
      apiHash,
      { connectionRetries: 3 }
    );

    try {
      await unmuteClient.connect();
      const inputChannelAgain = await getChannelEntity(unmuteClient, channelLink);

      await unmuteClient.invoke(new Api.account.UpdateNotifySettings({
        peer: inputChannelAgain,
        settings: new Api.InputPeerNotifySettings({
          muteUntil: 0
        })
      }));

      console.log(`[AUTO-UNMUTE] ${acc.phoneNumber} → unmuted after ${duration} minutes`);
    } catch (err) {
      console.error(`[AUTO-UNMUTE ERROR] ${acc.phoneNumber} →`, err.message);
    } finally {
      if (unmuteClient && unmuteClient.connected) {
        await unmuteClient.disconnect();
      }
    }
  }, unmuteDelay);
}



        await client.disconnect();
      } catch (err) {
        console.error(`[${acc.phoneNumber}] Error in mute/unmute:`, err.message);
        if (client && client.connected) await client.disconnect();
      }
    });

    res.json({ success: true, message: `Mute/Unmute command sent to ${accounts.length} accounts.` });

  } catch (error) {
    console.error('Mute/Unmute error:', error);
    res.status(500).json({ success: false, message: 'Failed to process mute/unmute request.' });
  }
});



// Route to add views to a post in a channel
app.post('/api/add-views', async (req, res) => {
  const { channelLink, timeDelay, runMinutes } = req.body;

  if (!channelLink || !timeDelay || !runMinutes) {
    return res.status(400).json({ success: false, message: 'Missing parameters.' });
  }

  let delayMs;
  try {
    delayMs = parseDurationToMs(timeDelay);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }

  try {
    const accounts = await Account.find();
    const postId = await getLatestPostIdFromChannel(channelLink, accounts[0]);
    const selectedAccounts = accounts.slice(0, 50); // Use max 50 accounts or adjust as needed

    selectedAccounts.forEach((acc, index) => {
      const timeout = index * delayMs;
      setTimeout(async () => {
        const client = new TelegramClient(
          new StringSession(acc.stringSession),
          apiId,
          apiHash,
          { connectionRetries: 3 }
        );

        try {
          await client.connect();
          const inputChannel = await getChannelEntity(client, channelLink);

          await client.invoke(
            new Api.messages.GetMessagesViews({
              peer: inputChannel,
              id: [postId],
              increment: true
            })
          );
          console.log(`[VIEWS] ${acc.phoneNumber} viewed message ID ${postId}`);
        } catch (err) {
          console.warn(`[VIEW ERROR] ${acc.phoneNumber} →`, err.message);
        } finally {
          await client.disconnect();
        }
      }, timeout);
    });

    return res.json({ success: true, message: `Scheduled ${selectedAccounts.length} views.` });

  } catch (error) {
    console.error('[VIEWS ROUTE ERROR]:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Duration Parsing Helper
function parseDurationToMs(str) {
  if (typeof str !== 'string') str = String(str);
  str = str.trim().toLowerCase();

  if (str.endsWith('s')) return parseInt(str) * 1000;
  if (str.endsWith('m')) return parseInt(str) * 60 * 1000;

  throw new Error(`Invalid time format: ${str}`);
}

// Helper to get latest post ID
async function getLatestPostIdFromChannel(channelLink, account) {
  const client = new TelegramClient(
    new StringSession(account.stringSession),
    apiId,
    apiHash,
    { connectionRetries: 3 }
  );
  await client.connect();
  try {
    const inputChannel = await getChannelEntity(client, channelLink);
    const messages = await client.getMessages(inputChannel, { limit: 1 });
    if (messages.length > 0) return messages[0].id;
    throw new Error('No messages found in channel.');
  } finally {
    await client.disconnect();
  }
}

//live Session

app.post('/api/live-session', async (req, res) => {
  const {
    channelLink,
    accountCount,
    joinTime,
    leaveTime,
    raiseHandCount,
    raiseHandDelay
  } = req.body;

  try {
    const allAccounts = await Account.find();
    const usableAccounts = [];

    // Filter accounts that are already in the channel
    for (const acc of allAccounts) {
      const client = new TelegramClient(new StringSession(acc.stringSession), apiId, apiHash, {
        connectionRetries: 3,
      });

      try {
        await client.connect();
        const inputChannel = await getChannelEntity(client, channelLink);

        // Check if account is participant
        await client.invoke(new Api.channels.GetParticipant({
          channel: inputChannel,
          participant: 'me',
        }));

        usableAccounts.push({ acc, inputChannel });
      } catch (err) {
        if (!err.message.includes('USER_NOT_PARTICIPANT')) {
          console.warn(`[SKIP] ${acc.phoneNumber}: ${err.message}`);
        }
      } finally {
        await client.disconnect();
      }
    }

    const selected = usableAccounts.slice(0, accountCount);
    if (selected.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid accounts found in the channel.' });
    }

    const joinDelay = Math.max(0, moment(joinTime).valueOf() - Date.now());
    const leaveDelay = Math.max(0, moment(leaveTime).valueOf() - Date.now());
    const raiseDelayMs = parseDelayToMs(raiseHandDelay);

    // Schedule session
    setTimeout(() => {
      selected.forEach(({ acc, inputChannel }, index) => {
        (async () => {
          const client = new TelegramClient(new StringSession(acc.stringSession), apiId, apiHash, {
            connectionRetries: 3,
          });

          try {
            await client.connect();
            console.log(`[LIVE JOIN] ${acc.phoneNumber} joined ${channelLink}`);

            // Raise Hand simulation (send emoji message)
            if (index < raiseHandCount) {
              setTimeout(async () => {
                try {
                  await client.sendMessage(inputChannel, { message: '[👋] Raised Hand' });
                  console.log(`[HAND RAISE] ${acc.phoneNumber}`);
                } catch (err) {
                  console.warn(`[HAND ERROR] ${acc.phoneNumber}: ${err.message}`);
                }
              }, raiseDelayMs);
            }

            // Schedule leave
            setTimeout(async () => {
              try {
                await client.invoke(new Api.channels.LeaveChannel({ channel: inputChannel }));
                console.log(`[LEFT LIVE] ${acc.phoneNumber}`);
              } catch (err) {
                console.warn(`[LEAVE ERROR] ${acc.phoneNumber}: ${err.message}`);
              } finally {
                await client.disconnect();
              }
            }, leaveDelay - joinDelay);

          } catch (err) {
            console.error(`[JOIN FAIL] ${acc.phoneNumber}: ${err.message}`);
            await client.disconnect();
          }
        })();
      });
    }, joinDelay);

    res.json({ success: true, message: `${selected.length} accounts scheduled for live session.` });

  } catch (err) {
    console.error('[LIVE SESSION ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Live session failed to schedule.' });
  }
});

// Helper to convert delay strings like "5s", "2m"
function parseDelayToMs(input) {
  const match = input.match(/(\d+)\s*(s|m|h)/i);
  if (!match) return 0;
  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  return 0;
}







// Serve the index.html file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));