
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";

import { getStore } from "@netlify/blobs";

const client = new CostExplorerClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.COST_BOT_ACCESS_KEY_ID,
    secretAccessKey: process.env.COST_BOT_SECRET_ACCESS_KEY,
  },
});

const store = getStore("aws-cost-history");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const CHAT_IDS = [
  process.env.TELEGRAM_CHAT_ID,
  process.env.TELEGRAM_GROUP_CHAT_ID,
].filter(Boolean);

const SERVICE_LABELS = [
  "S3",
  "RDS",
  "EC2-Instances",
  "EC2-Other",
  "VPC",
  "CloudTrail",
  "CloudShell",
  "Glue",
  "Cost Explorer",
  "Others",
];

function getIndiaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

function getIndiaTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function formatDate(dateString) {
  return new Date(`${dateString}T00:00:00Z`).toLocaleDateString(
    "en-US",
    {
      timeZone: "UTC",
      month: "short",
      day: "2-digit",
      year: "numeric",
    }
  );
}

function formatCost(amount) {
  return `$${Number(amount || 0).toFixed(4)}`;
}

function classifyService(name) {
  const service = name.toLowerCase();

  if (service.includes("simple storage") || service === "s3") {
    return "S3";
  }

  if (
    service.includes("relational database") ||
    service.includes("rds")
  ) {
    return "RDS";
  }

  if (
    service.includes("cost explorer") ||
    service.includes("cost management")
  ) {
    return "Cost Explorer";
  }

  if (
    service.includes("ec2 - other") ||
    service.includes("ec2 other")
  ) {
    return "EC2-Other";
  }

  if (
    service.includes("elastic compute cloud") ||
    service.includes("ec2 - instances") ||
    service.includes("ec2 instances") ||
    service.includes("ec2-instance")
  ) {
    return "EC2-Instances";
  }

  if (
    service.includes("virtual private cloud") ||
    service.includes("vpc")
  ) {
    return "VPC";
  }

  if (service.includes("cloudtrail")) {
    return "CloudTrail";
  }

  if (service.includes("cloudshell")) {
    return "CloudShell";
  }

  if (service.includes("glue")) {
    return "Glue";
  }

  return "Others";
}

// Fetch AWS cost
async function fetchCosts(startDate, endDate, granularity) {
  const command = new GetCostAndUsageCommand({
    TimePeriod: {
      Start: startDate,
      End: endDate,
    },
    Granularity: granularity,
    Metrics: ["UnblendedCost"],
    GroupBy: [
      {
        Type: "DIMENSION",
        Key: "SERVICE",
      },
    ],
  });

  const response = await client.send(command);

  const services = Object.fromEntries(
    SERVICE_LABELS.map((label) => [label, 0])
  );

  let total = 0;

  for (const period of response.ResultsByTime || []) {
    for (const group of period.Groups || []) {
      const serviceName = group.Keys?.[0] || "Other";

      const amount = Number(
        group.Metrics?.UnblendedCost?.Amount || 0
      );

      const label = classifyService(serviceName);

      services[label] += amount;
      total += amount;
    }

    if (
      (!period.Groups || period.Groups.length === 0) &&
      period.Total?.UnblendedCost?.Amount !== undefined
    ) {
      total += Number(period.Total.UnblendedCost.Amount);
    }
  }

  return {
    total,
    services,
  };
}

// Save first and latest snapshots for a date
async function saveDailySnapshot(date, currentData) {
  const key = `daily-${date}`;

  const previous = await store.get(key, {
    type: "json",
    consistency: "strong",
  });

  const now = new Date().toISOString();

  // First snapshot for this date
  if (!previous) {
    const firstUpdate = {
      total: currentData.total,
      services: currentData.services,
      capturedAt: now,
    };

    const snapshot = {
      date,
      firstUpdate,
      latestUpdate: firstUpdate,
      secondUpdate: null,
    };

    await store.setJSON(key, snapshot);

    console.log(`First snapshot saved for ${date}`);

    return snapshot;
  }

  // Check whether the latest AWS data changed
  const previousTotal = Number(
    previous.latestUpdate.total || 0
  );

  const currentTotal = Number(currentData.total || 0);

  const hasChanged = previousTotal !== currentTotal;

  let secondUpdate = previous.secondUpdate || null;

  if (hasChanged) {
    // Save the latest detected change time.
    // This can happen the following morning too.
    secondUpdate = {
      detectedAt: now,
      additionalCost:
        currentTotal - Number(previous.firstUpdate.total || 0),
    };

    console.log(`Cost change detected for ${date}`);
  }

  const snapshot = {
    date,

    // Never overwrite the first snapshot
    firstUpdate: previous.firstUpdate,

    // Always keep the latest AWS cumulative cost
    latestUpdate: {
      total: currentData.total,
      services: currentData.services,
      capturedAt: now,
    },

    secondUpdate,
  };

  await store.setJSON(key, snapshot);

  return snapshot;
}

// Format yesterday's snapshot for notification
function getYesterdayReport(snapshot) {
  if (!snapshot) {
    return {
      firstTime: "Not available",
      firstCost: 0,
      secondTime: "No second update detected",
      additionalCost: 0,
      total: 0,
    };
  }

  const firstTime = getIndiaTime(
    new Date(snapshot.firstUpdate.capturedAt)
  );

  const secondTime = snapshot.secondUpdate
    ? getIndiaTime(new Date(snapshot.secondUpdate.detectedAt))
    : "No second update detected yet";

  const firstCost = Number(snapshot.firstUpdate.total || 0);

  // Latest cumulative cost minus first snapshot
  const total = Number(snapshot.latestUpdate.total || 0);

  const additionalCost = total - firstCost;

  return {
    firstTime,
    firstCost,
    secondTime,
    additionalCost,
    total,
  };
}

// Send Telegram message
async function sendTelegramMessage(chatId, message) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram failed: ${JSON.stringify(result)}`
    );
  }

  console.log(
    `Telegram message sent successfully to ${chatId}`
  );
}

// Main report function
async function sendCostReport() {
  if (
    !process.env.COST_BOT_ACCESS_KEY_ID ||
    !process.env.COST_BOT_SECRET_ACCESS_KEY
  ) {
    throw new Error("AWS credentials are missing.");
  }

  if (!BOT_TOKEN || CHAT_IDS.length === 0) {
    throw new Error("Telegram configuration is missing.");
  }

  // Recalculate dates on every function execution
  const today = getIndiaDate();

  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);

  const monthStart = `${today.slice(0, 7)}-01`;

  console.log(`Fetching today's AWS cost: ${today} to ${tomorrow}`);

  console.log(
    `Fetching yesterday's AWS cost: ${yesterday} to ${today}`
  );

  console.log(
    `Fetching monthly AWS cost: ${monthStart} to ${tomorrow}`
  );

  // Fetch today, yesterday and current month costs
  const [
    dailyData,
    yesterdayData,
    monthlyData,
  ] = await Promise.all([
    fetchCosts(today, tomorrow, "DAILY"),

    fetchCosts(yesterday, today, "DAILY"),

    fetchCosts(monthStart, tomorrow, "MONTHLY"),
  ]);

  // Save today's snapshot and update yesterday's snapshot
  const [
    todaySnapshot,
    yesterdaySnapshot,
  ] = await Promise.all([
    saveDailySnapshot(today, dailyData),

    saveDailySnapshot(yesterday, yesterdayData),
  ]);

  // Prepare yesterday report
  const yesterdayReport = getYesterdayReport(
    yesterdaySnapshot
  );

  // Today's service breakdown
  const serviceLines = SERVICE_LABELS.map(
    (name) =>
      `• ${name}: ${formatCost(dailyData.services[name])}`
  );

  // Complete Telegram notification
  const message = `
📊 <b>AWS COST REPORT</b>

📅 Report Date: ${formatDate(today)}


📅 <b>YESTERDAY COST</b>

📅 Date: ${formatDate(yesterday)}

🕒 First Update: ${yesterdayReport.firstTime}
💰 First Cost: ${formatCost(yesterdayReport.firstCost)}

🕒 Second Update: ${yesterdayReport.secondTime}
💰 Additional Cost: ${formatCost(yesterdayReport.additionalCost)}

📌 Yesterday Total: ${formatCost(yesterdayReport.total)}


💰 <b>TODAY DAILY COST</b>

📅 Date: ${formatDate(today)}

${serviceLines.join("\n")}

📌 Today's Total: ${formatCost(dailyData.total)}


📊 <b>CURRENT MONTH TOTAL</b>

📌 Monthly Total: ${formatCost(monthlyData.total)}


🕒 Updated Check: ${getIndiaTime()} IST

⏱️ <b>Next Check</b>: Every 4 Hours
`.trim();

  // Send notification to personal and group chats
  const results = await Promise.allSettled(
    [...new Set(CHAT_IDS)].map((chatId) =>
      sendTelegramMessage(chatId, message)
    )
  );

  const failures = results.filter(
    (result) => result.status === "rejected"
  );

  failures.forEach((result) => {
    console.error(
      "Telegram notification error:",
      result.reason
    );
  });

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} Telegram notification(s) failed.`
    );
  }

  console.log("AWS cost report sent successfully.");
}

// Run every 4 hours
export const config = {
  schedule: "0 */4 * * *",
};

export default async () => {
  await sendCostReport();

  console.log("Cost report completed successfully.");
};
