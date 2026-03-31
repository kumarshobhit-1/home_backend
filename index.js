require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const { ethers } = require('ethers');

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com';
const MQTT_CONTROL_TOPIC = process.env.MQTT_CONTROL_TOPIC || 'bbd-smarthome/control';
const MQTT_STATUS_TOPIC = process.env.MQTT_STATUS_TOPIC || 'bbd-smarthome/status';
const BLOCKCHAIN_RPC_URL = process.env.BLOCKCHAIN_RPC_URL || 'http://127.0.0.1:7545';
const FORCED_USER_NAME = process.env.FORCED_USER_NAME || 'Admin (BBDU)';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
	.split(',')
	.map((id) => id.trim())
	.filter(Boolean);
const TELEGRAM_TIMEZONE = process.env.TELEGRAM_TIMEZONE || 'Asia/Kolkata';
const TELEGRAM_POLL_INTERVAL_MS = Number(process.env.TELEGRAM_POLL_INTERVAL_MS) || 1500;

const ALLOWED_COMMANDS = new Set([
	'DOOR_OPEN',
	'DOOR_CLOSE',
	'LIGHT_ON',
	'LIGHT_OFF',
	'FAN_ON',
	'FAN_OFF',
	'MCB_OFF',
	'MCB_ON',
]);

const sseClients = new Set();
let latestDeviceStatus = {
	temp: null,
	hum: null,
	mcb_status: true,
	updatedAt: null,
	raw: null,
};

const mqttClient = mqtt.connect(MQTT_BROKER_URL);

mqttClient.on('connect', () => {
	console.log(`[${new Date().toISOString()}] MQTT connected to ${MQTT_BROKER_URL}`);
	mqttClient.subscribe(MQTT_STATUS_TOPIC, (err) => {
		if (err) {
			console.error(`[${new Date().toISOString()}] MQTT subscribe error (${MQTT_STATUS_TOPIC}):`, err.message);
			return;
		}

		console.log(`[${new Date().toISOString()}] MQTT subscribed to status topic ${MQTT_STATUS_TOPIC}`);
	});
});

mqttClient.on('error', (err) => {
	console.error(`[${new Date().toISOString()}] MQTT error:`, err.message);
});

mqttClient.on('message', (topic, message) => {
	if (topic !== MQTT_STATUS_TOPIC) {
		return;
	}

	const raw = message.toString();
	try {
		const parsed = JSON.parse(raw);
		latestDeviceStatus = {
			temp: typeof parsed.temp === 'number' ? parsed.temp : null,
			hum: typeof parsed.hum === 'number' ? parsed.hum : null,
			mcb_status: typeof parsed.mcb_status === 'boolean' ? parsed.mcb_status : true,
			updatedAt: new Date().toISOString(),
			raw,
		};
	} catch {
		latestDeviceStatus = {
			temp: null,
			hum: null,
			mcb_status: true,
			updatedAt: new Date().toISOString(),
			raw,
		};
	}

	broadcastStatus(latestDeviceStatus);
});

function broadcastStatus(statusPayload) {
	const message = `data: ${JSON.stringify(statusPayload)}\n\n`;
	for (const client of sseClients) {
		client.write(message);
	}
}

async function sendTelegramMessage(chatId, message) {
	if (!TELEGRAM_BOT_TOKEN || !chatId) {
		return;
	}

	await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text: message,
		}),
	});
}

async function sendTelegramAlert(message) {
	if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
		return;
	}

	try {
		await Promise.all(
			TELEGRAM_CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, message))
		);
	} catch (err) {
		console.warn(`[${new Date().toISOString()}] Telegram alert failed (non-fatal):`, err.message);
	}
}

function formatTelegramTime(date = new Date()) {
	try {
		return new Intl.DateTimeFormat('en-IN', {
			timeZone: TELEGRAM_TIMEZONE,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: true,
		}).format(date);
	} catch {
		return date.toISOString();
	}
}

function getTelegramHelpText() {
	return [
		'SmartHome Bot Commands',
		'/status',
		'/door_open or /door_close',
		'/light_on or /light_off',
		'/fan_on or /fan_off',
		'/mcb_off or /mcb_on',
	].join('\n');
}

function parseTelegramControlCommand(text) {
	const normalized = String(text || '')
		.trim()
		.toUpperCase()
		.replace(/\s+/g, '_');

	const commandMap = {
		'/DOOR_OPEN': { device: 'Main Door', command: 'DOOR_OPEN' },
		'/DOOR_CLOSE': { device: 'Main Door', command: 'DOOR_CLOSE' },
		'/UNLOCK': { device: 'Main Door', command: 'DOOR_OPEN' },
		'/LOCK': { device: 'Main Door', command: 'DOOR_CLOSE' },
		'/LIGHT_ON': { device: 'Living Room Light', command: 'LIGHT_ON' },
		'/LIGHT_OFF': { device: 'Living Room Light', command: 'LIGHT_OFF' },
		'/FAN_ON': { device: 'Ceiling Fan', command: 'FAN_ON' },
		'/FAN_OFF': { device: 'Ceiling Fan', command: 'FAN_OFF' },
		'/MCB_OFF': { device: 'Master System', command: 'MCB_OFF' },
		'/MCB_ON': { device: 'Master System', command: 'MCB_ON' },
	};

	return commandMap[normalized] || null;
}

async function executeDeviceControl({ device, command, safeUser }) {
	if (!device || !command) {
		throw new Error('Invalid payload. device and command are required');
	}

	if (!ALLOWED_COMMANDS.has(command)) {
		throw new Error('Unsupported command');
	}

	const safeDevice = String(device).slice(0, 120);
	const actor = String(safeUser || FORCED_USER_NAME).slice(0, 120);

	await new Promise((resolve, reject) => {
		mqttClient.publish(MQTT_CONTROL_TOPIC, command, (err) => {
			if (err) {
				reject(new Error('Failed to publish device command'));
				return;
			}
			resolve();
		});
	});

	let transactionHash = null;

	if (contract && provider && wallet) {
		try {
			const action = `${safeDevice} ${command}`;
			const timestamp = Math.floor(Date.now() / 1000);

			console.log(`[${new Date().toISOString()}] Blockchain: Calling addLog('${action}', '${actor}', ${timestamp})`);

			const tx = await contract.addLog(action, actor, timestamp);
			transactionHash = tx.hash;

			console.log(`[${new Date().toISOString()}] Blockchain: Transaction sent, hash: ${transactionHash}`);

			const receipt = await tx.wait();

			console.log(`[${new Date().toISOString()}] Blockchain: Transaction confirmed, block: ${receipt.blockNumber}`);
		} catch (blockchainErr) {
			console.error(`[${new Date().toISOString()}] Blockchain error (non-fatal):`, blockchainErr.message);
		}
	}

	const alertText = `SmartHome Alert\nAction: ${safeDevice} ${command}\nUser: ${actor}\nTime: ${formatTelegramTime()} (${TELEGRAM_TIMEZONE})`;
	await sendTelegramAlert(alertText);

	return {
		safeDevice,
		command,
		actor,
		transactionHash,
	};
}

let telegramUpdateOffset = 0;

async function handleTelegramMessage(message) {
	if (!message || !message.chat || typeof message.text !== 'string') {
		return;
	}

	const chatId = String(message.chat.id);
	const isAllowedChat = TELEGRAM_CHAT_IDS.length === 0 || TELEGRAM_CHAT_IDS.includes(chatId);

	if (!isAllowedChat) {
		await sendTelegramMessage(chatId, 'Unauthorized chat. Ask admin to add your chat id.');
		return;
	}

	const text = message.text.trim();
	const normalized = text.toLowerCase();

	if (normalized === '/start' || normalized === '/help') {
		await sendTelegramMessage(chatId, getTelegramHelpText());
		return;
	}

	if (normalized === '/status') {
		const statusText = [
			'SmartHome Status',
			`Temp: ${typeof latestDeviceStatus.temp === 'number' ? `${latestDeviceStatus.temp.toFixed(1)} C` : 'N/A'}`,
			`Humidity: ${typeof latestDeviceStatus.hum === 'number' ? `${latestDeviceStatus.hum.toFixed(1)} %` : 'N/A'}`,
			`MCB: ${latestDeviceStatus.mcb_status ? 'ON' : 'OFF'}`,
			`Updated: ${latestDeviceStatus.updatedAt ? formatTelegramTime(new Date(latestDeviceStatus.updatedAt)) : 'N/A'}`,
		].join('\n');

		await sendTelegramMessage(chatId, statusText);
		return;
	}

	const control = parseTelegramControlCommand(text);
	if (!control) {
		await sendTelegramMessage(chatId, `Unknown command.\n\n${getTelegramHelpText()}`);
		return;
	}

	try {
		const result = await executeDeviceControl({
			device: control.device,
			command: control.command,
			safeUser: FORCED_USER_NAME,
		});

		await sendTelegramMessage(
			chatId,
			`Command executed\nAction: ${result.safeDevice} ${result.command}\nUser: ${result.actor}${
				result.transactionHash ? `\nTx: ${result.transactionHash}` : ''
			}`
		);
	} catch (err) {
		console.error(`[${new Date().toISOString()}] Telegram command error:`, err.message);
		await sendTelegramMessage(chatId, `Command failed: ${err.message}`);
	}
}

async function pollTelegramUpdates() {
	if (!TELEGRAM_BOT_TOKEN) {
		return;
	}

	try {
		const updatesUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=25&offset=${telegramUpdateOffset}`;
		const response = await fetch(updatesUrl);
		const payload = await response.json();

		if (!payload.ok || !Array.isArray(payload.result)) {
			throw new Error(payload.description || 'Telegram getUpdates failed');
		}

		for (const update of payload.result) {
			telegramUpdateOffset = update.update_id + 1;
			if (update.message) {
				await handleTelegramMessage(update.message);
			}
		}
	} catch (err) {
		console.warn(`[${new Date().toISOString()}] Telegram polling warning:`, err.message);
	} finally {
		setTimeout(pollTelegramUpdates, TELEGRAM_POLL_INTERVAL_MS);
	}
}

// Blockchain setup (ethers.js v6)
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// Minimal ABI for addLog function
const CONTRACT_ABI = [
	{
		type: 'function',
		name: 'addLog',
		inputs: [
			{ name: 'action', type: 'string' },
			{ name: 'user', type: 'string' },
			{ name: 'timestamp', type: 'uint256' },
		],
		outputs: [],
		stateMutability: 'nonpayable',
	},
];

let provider;
let wallet;
let contract;

if (PRIVATE_KEY && CONTRACT_ADDRESS) {
	try {
		provider = new ethers.JsonRpcProvider(BLOCKCHAIN_RPC_URL);
		wallet = new ethers.Wallet(PRIVATE_KEY, provider);
		contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
		console.log(`[${new Date().toISOString()}] Blockchain: Provider connected at ${BLOCKCHAIN_RPC_URL}`);
		console.log(`[${new Date().toISOString()}] Blockchain: Wallet loaded, contract ready at ${CONTRACT_ADDRESS}`);
	} catch (err) {
		console.warn(`[${new Date().toISOString()}] Blockchain setup warning:`, err.message);
	}
} else {
	console.warn(`[${new Date().toISOString()}] Blockchain disabled: PRIVATE_KEY or CONTRACT_ADDRESS not set in .env`);
}

app.use(
	cors({
		origin: 'https://homeiotsecure.vercel.app',
		methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		credentials: true,
	})
);

app.use(express.json());

// Minimal request logging for easier debugging.
app.use((req, res, next) => {
	const start = Date.now();

	res.on('finish', () => {
		const durationMs = Date.now() - start;
		console.log(
			`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`
		);
	});

	next();
});

app.get('/', (req, res) => {
	res.status(200).json({ status: 'Server is healthy and running' });
});

app.get('/api/health', (req, res) => {
	res.status(200).json({
		timestamp: new Date().toISOString(),
		mqttConnected: mqttClient.connected,
		blockchainEnabled: Boolean(contract && provider && wallet),
		statusTopic: MQTT_STATUS_TOPIC,
		controlTopic: MQTT_CONTROL_TOPIC,
	});
});

app.get('/api/device/status', (req, res) => {
	res.status(200).json({
		success: true,
		status: latestDeviceStatus,
	});
});

app.get('/api/device/stream', (req, res) => {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
	});

	res.write(`data: ${JSON.stringify(latestDeviceStatus)}\n\n`);
	sseClients.add(res);

	const keepAliveTimer = setInterval(() => {
		res.write(': ping\n\n');
	}, 25000);

	req.on('close', () => {
		clearInterval(keepAliveTimer);
		sseClients.delete(res);
	});
});

app.post('/api/device/control', (req, res) => {
	const { device, command } = req.body || {};

	executeDeviceControl({
		device,
		command,
		safeUser: FORCED_USER_NAME,
	})
		.then((result) => {
			const responsePayload = {
				success: true,
				message: 'Device command published successfully',
				topic: MQTT_CONTROL_TOPIC,
			};

			if (result.transactionHash) {
				responsePayload.transactionHash = result.transactionHash;
			}

			res.status(200).json(responsePayload);
		})
		.catch((err) => {
			const statusCode = err.message === 'Unsupported command' || err.message.includes('Invalid payload') ? 400 : 500;
			res.status(statusCode).json({ error: err.message });
		});
});

app.use((req, res) => {
	res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
	console.error(`[${new Date().toISOString()}] Error:`, err.message);

	if (res.headersSent) {
		return next(err);
	}

	res.status(err.status || 500).json({
		error: 'Internal server error',
	});
});

app.listen(PORT, () => {
	console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`);
	if (TELEGRAM_BOT_TOKEN) {
		console.log(`[${new Date().toISOString()}] Telegram command polling enabled`);
		pollTelegramUpdates();
	}
});

