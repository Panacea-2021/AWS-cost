import {
  CostExplorerClient,
  GetCostAndUsageCommand
} from "@aws-sdk/client-cost-explorer";

const AWS_ACCESS_KEY_ID = process.env.COST_BOT_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.COST_BOT_SECRET_ACCESS_KEY;
const AWS_REGION = process.env.COST_BOT_REGION || "ap-south-1";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID;

const IST = "Asia/Kolkata";

const required = {
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID
};

const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length) {
  throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

const costClient = new CostExplorerClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY
  }
});

const SERVICE_MAPPING = {
  S3: [
    "Amazon Simple Storage Service",
    "Amazon S3",
    "S3"
  ],
  RDS: [
    "Amazon Relational Database Service",
    "Relational Database Service"
  ],
  "EC2-Instances": [
    "EC2 - Instances",
    "EC2-Instances",
    "Amazon Elastic Compute Cloud - Compute"
  ],
  "Cost Explorer": [
    "AWS Cost Explorer",
    "Cost Explorer"
  ],
  "EC2-Other": [
    "EC2 - Other",
    "EC2-Other"
  ],
  VPC: [
    "Amazon Virtual Private Cloud",
    "Amazon VPC",
    "VPC"
  ],
  CloudTrail: [
    "AWS CloudTrail",
    "Amazon CloudTrail",
    "CloudTrail"
  ],
  CloudShell: [
    "AWS CloudShell",
    "CloudShell"
  ],
  Glue: [
    "AWS Glue",
    "Glue"
  ]
};

// Get today's date in India
function getISTDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getUpdatedTime() {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).format(new Date());
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

// Get all pages from AWS Cost Explorer
async function getCostData(startDate, endDate, granularity, groupBy = []) {
  let nextPageToken;
  const results = [];

  do {
    const response = await costClient.send(
      new GetCostAndUsageCommand({
        TimePeriod: {
          Start: startDate,
          End: endDate
        },
        Granularity: granularity,
        Metrics: ["UnblendedCost"],
        ...(groupBy.length ? { GroupBy: groupBy } : {}),
        ...(nextPageToken ? { NextPageToken: nextPageToken } : {})
      })
    );

    results.push(...(response.ResultsByTime || []));
    nextPageToken = response.NextPageToken;
  } while (nextPageToken);

  return results;
}

// Daily service-wise cost and daily total
async function getDailyCosts(today) {
  const results = await getCostData(
    today,
    addDays(today, 1),
    "DAILY",
    [{ Type: "DIMENSION", Key: "SERVICE" }]
  );

  const serviceCosts = {};
  let total = 0;
  let unit = "USD";

  for (const period of results) {
    const totalMetric = period.Total?.UnblendedCost;

    if (totalMetric) {
      total += Number(totalMetric.Amount);
      unit = totalMetric.Unit || unit;
    }

    for (const group of period.Groups || []) {
      const name = group.Keys[0];
      const metric = group.Metrics.UnblendedCost;

      serviceCosts[name] =
        (serviceCosts[name] || 0) + Number(metric.Amount);

      unit = metric.Unit || unit;
    }
  }

  return { serviceCosts, total, unit };
}

// Current month's accumulated cost
async function getMonthlyTotal(today) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const tomorrow = addDays(today, 1);

  const results = await getCostData(
    monthStart,
    tomorrow,
    "MONTHLY"
  );

  const metric = results[0]?.Total?.UnblendedCost;

  return {
    total: Number(metric?.Amount || 0),
    unit: metric?.Unit || "USD"
  };
}

function formatServiceCosts(rawCosts) {
  const formatted = {};

  for (const category of Object.keys(SERVICE_MAPPING)) {
    formatted[category] = 0;
  }

  formatted.Others = 0;

  for (const [serviceName, amount] of Object.entries(rawCosts)) {
    const normalized = serviceName.trim().toLowerCase();

    const category = Object.entries(SERVICE_MAPPING).find(
      ([, aliases]) =>
        aliases.some((alias) => alias.toLowerCase() === normalized)
    )?.[0];

    if (category) {
      formatted[category] += amount;
    } else {
      formatted.Others += amount;
    }
  }

  return formatted;
}

// Send message to personal Telegram and group
async function sendTelegramMessage(message) {
  const chatIds = [
    ...new Set([
      TELEGRAM_CHAT_ID,
      TELEGRAM_GROUP_CHAT_ID
    ].filter(Boolean))
  ];

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (const chatId of chatIds) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML"
      })
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(
        `Telegram message failed for chat ${chatId}: ${JSON.stringify(result)}`
      );
    }

    console.log(`Telegram message sent to ${chatId}`);
  }
}

function formatDate(dateString) {
  const [year, month, day] = dateString.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    year: "numeric"
  }).format(date);
}

async function sendCostReport() {
  const today = getISTDate();

  console.log(`Fetching AWS cost report for ${today}`);

  const daily = await getDailyCosts(today);
  const monthly = await getMonthlyTotal(today);

  const serviceCosts = formatServiceCosts(daily.serviceCosts);

  let message =
    "📊 <b>AWS COST REPORT</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n\n" +
    `📅 <b>Report Date:</b> ${formatDate(today)}\n\n` +
    "💰 <b>DAILY SERVICE COST</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n";

  for (const [service, amount] of Object.entries(serviceCosts)) {
    message +=
      `• ${escapeHtml(service)}: ` +
      `<b>${amount.toFixed(4)} ${daily.unit}</b>\n`;
  }

  message +=
    "\n━━━━━━━━━━━━━━━━━━\n" +
    `📌 <b>Daily Total:</b> ${daily.total.toFixed(4)} ${daily.unit}\n` +
    `📅 <b>Current Month Total:</b> ${monthly.total.toFixed(4)} ${monthly.unit}\n` +
    "━━━━━━━━━━━━━━━━━━\n\n" +
    `🕒 <b>Updated Check:</b> ${getUpdatedTime()} IST\n` +
    "⏱️ <b>Next Check:</b> Every 2 Hours";

  await sendTelegramMessage(message);

  console.log("AWS cost report sent successfully");
}

// Netlify Scheduled Function
export default async () => {
  try {
    await sendCostReport();

    return new Response("AWS cost report sent successfully", {
      status: 200
    });
  } catch (error) {
    console.error("AWS Cost Monitoring Error:", error);

    return new Response("AWS cost report failed. Check function logs.", {
      status: 500
    });
  }
};

// Runs every 2 hours (cron is UTC)
export const config = {
  schedule: "0 */2 * * *"
};
