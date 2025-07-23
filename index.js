const mqtt = require("mqtt");
require("dotenv").config({ quiet: true });
const {
  Client,
  Events,
  GatewayIntentBits,
  TextChannel,
} = require("discord.js");
const fs = require("fs");

// Create a new client instance
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const token = process.env.BOT_TOKEN;
const alertChannel = process.env.ALERT_CHANNEL;
const logChannel = process.env.LOG_CHANNEL;
const alertRoleId = process.env.ALERT_ROLE_ID;

let currentCanState = {};
// Array of CanMessages
// CanMessage = {
//  time: number;
//  id: number;
//  data: number[];
// }
const canMessages = [];

client.login(token);

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord bot ready! Logged in as ${readyClient.user.tag}`);
});

const url = "mqtt://telemetry.arus.es:1883";

const mqttOptions = {
  clean: true,
  connectTimeout: 4000,
  // Authentication
  mqttClientId: "discord_bot",
  username: "",
  password: "",
};

const mqttClient = mqtt.connect(url, mqttOptions);
mqttClient.on("connect", function () {
  console.log("Connected to telemetry.arus.es.");
  mqttClient.subscribe("ART/status", async function (err) {
    if (!err) {
      console.log("Subscribed to status topic!");
    } else {
      console.error("Error subscribing to topic! Error:");
      console.err(err.message);
    }
  });
});

let sessionActive = false;
let lowBatMsgSent = false;
let disconnectTimeoutId;
let prevMsgLen;
// Receive messages
mqttClient.on("message", function (topic, message) {
  if (topic === "ART/status") {
    try {
      const newCanState = {};
      const msgLen = message.byteLength;

      // Car stopped and started within 10 seconds,
      // highly unlikely but we need to handle it
      if (msgLen < prevMsgLen) makeLog();

      if (!sessionActive) {
        client.channels.cache.get(alertChannel).send({
          content: `<@&${alertRoleId}> Car started up! Recording log...`,
        });
        sessionActive = true;
        lowBatMsgSent = false;
      }

      // Set timeout every message so that if no message is received
      // after 1 second the car is assumed to be disconnected
      clearTimeout(disconnectTimeoutId);
      disconnectTimeoutId = setTimeout(() => {
        makeLog();
      }, 10000);

      // Check that the message is valid
      // (a can message in this format is a constant 10)
      if ((msgLen - 5) % 10 !== 0) {
        throw new Error(
          `Message lenght does not match, message possibly corrupted? (${msgLen})`
        );
      }

      const msgTime =
        (message[4] << 24) |
        (message[3] << 16) |
        (message[2] << 8) |
        message[1];

      for (let i = 5; i < msgLen - 1; i += 10) {
        const msgId = (message[i + 1] << 8) | message[i];
        const msgData = [];
        for (let j = 0; j < 8; j++) {
          msgData.push(message[i + j + 2]); // Skip ID
        }

        // Check LV voltage and alert if needed
        if (msgId == 0x185 && !lowBatMsgSent) {
          const lowVolts = ((msgData[1] << 8) | msgData[0]) / 1000;
          if (lowVolts < 12.8) {
            client.channels.cache.get(alertChannel).send({
              content: `<@&${alertRoleId}> LV battery is low!! (Measured voltage ${lowVolts}V).`,
            });
            lowBatMsgSent = true;
          }
        }

        newCanState[msgId] = msgData;
      }
      // Check which IDs changed
      for (id of Object.keys(newCanState)) {
        if (
          JSON.stringify(newCanState[id]) !==
          JSON.stringify(currentCanState[id])
        ) {
          canMessages.push({
            time: msgTime,
            id: id,
            data: newCanState[id],
          });
        }
      }

      currentCanState = newCanState;
    } catch (e) {
      console.error(e);
    }
  }
});

function makeLog() {
  // Process log here
  const logTime = Math.floor(Date.now() / 1000);
  const timestamp = `<t:${logTime}:f>`; // Example: Short Date/Time format
  const f = fs.createWriteStream(`./art_logs/${logTime}.txt`);
  f.on("open", async function (fd) {
    // Writes Kvaser like header
    f.write(`                              ARUS ART TELEMETRY Log
                              ======================
                                                        
Settings:
   Format of data field: HEX
   Format of id field:   HEX
   Timestamp Offset:     0          s
   CAN channel:          1 

        Time Chan   Identifier Flags        DLC  Data                                                                                                                                                                                                   Counter
============================================================================================================================================================================================================================================================\n`);
    
    // Yet another header
    f.write(
      `    0.000  Trigger (type=0x1, active=0x00, pre-trigger=0, post-trigger=-1)\n`
    );

    for (let i = 0; i < canMessages.length; i++) {
      // Format is stupid cuz of kvaser, this just adds the line
      f.write(
        `    ${canMessages[i].time / 1000}  1         ${
          canMessages[i].id
        }    Rx            8  ${canMessages[i].data
          .filter((n) => n !== undefined)
          .map((n) => n.toString(16).toUpperCase().padStart(2, "0"))
          .join(
            " "
          )}                                                                                                                                                                                              ${i}\n`
      );
    }
    f.end();
    currentCanState = {};
    sessionActive = false;
    client.channels.cache.get(logChannel).send({
      content: `Car session ended at ${timestamp}, download log here:`,
      files: [`./art_logs/${logTime}.txt`],
    });
  });
}
