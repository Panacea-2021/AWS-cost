
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";

const client = new CostExplorerClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.COST_BOT_ACCESS_KEY_ID,
    secretAccessKey: process.env.COST_BOT_SECRET_ACCESS_KEY,
  },
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const CHAT_IDS = [
  process.env.TELEGRAM_CHAT_ID,
  process.env.TELEGRAM_GROUP_CHAT_ID,
].filter(Boolean);

const SERVICE_LABELS = [
  "S3",
  "RDS",
  "EC2-Instances",
  "Cost Explorer",
  "EC2-Other",
  "VPC",
  "CloudTrail",
  "CloudShell",
  "Glue",
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

function getIndiaTime() {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date());
}

function subtractDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
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
  return `$${amount.toFixed(4)}`;
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
    service.includes("ec2 - instances") ||
    service.includes("ec2 instances") ||
    service.includes("ec2-instance")
  ) {
    return "EC2-Instances";
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
    service.includes("virtual private cloud") ||
    service === "vpc" ||
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

    // Use period total only if service groups are unavailable.
    if (
      (!period.Groups || period.Groups.length === 0) &&
      period.Total?.UnblendedCost?.Amount !== undefined
    ) {
      total += Number(period.Total.UnblendedCost.Amount);
    }
  }

  return { total, services };
}

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

async function sendCostReport() {
  if (
    !process.env.COST_BOT_ACCESS_KEY_ID ||
    !process.env.COST_BOT_SECRET_ACCESS_KEY
  ) {
    throw new Error("AWS credentials are missing.");
  }

  if (!BOT_TOKEN) {
    throw new Error("Telegram bot token is missing.");
  }

  if (CHAT_IDS.length === 0) {
    throw new Error("Telegram chat IDs are missing.");
  }

  const today = getIndiaDate();
  const yesterday = subtractDays(today, 1);
  const monthStart = `${today.slice(0, 7)}-01`;

  console.log(`Fetching daily AWS cost for ${yesterday}`);
  console.log(
    `Fetching monthly AWS cost from ${monthStart} to ${today}`
  );

  // Previous complete day cost (End date is exclusive).
  const dailyData = await fetchCosts(
    yesterday,
    today,
    "DAILY"
  );

  // Current month cost up to yesterday.
  const monthlyData = await fetchCosts(
    monthStart,
    today,
    "MONTHLY"
  );

  const serviceLines = SERVICE_LABELS.map(
    (name) => `• ${name}: ${formatCost(dailyData.services[name])}`
  );

  const reportDate = formatDate(today);
  const updatedTime = getIndiaTime();

  const message = `
📊 AWS COST REPORT

📅 Report Date: ${reportDate}

💰 DAILY SERVICE COST

${serviceLines.join("\n")}

📌 Daily Total: ${formatCost(dailyData.total)}
📅 Current Month Total: ${formatCost(monthlyData.total)}

🕒 Updated Check: ${updatedTime} IST
⏱️ Next Check: Every 2 Hours
`.trim();

  const results = await Promise.allSettled(
    [...new Set(CHAT_IDS)].map((chatId) =>
      sendTelegramMessage(chatId, message)
    )
  );

  const failures = results.filter(
    (result) => result.status === "rejected"
  );

  failures.forEach((result) => {
    console.error("Telegram notification error:", result.reason);
  });

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} Telegram notification(s) failed.`
    );
  }

  console.log("AWS cost report sent successfully.");
}

export const config = {
  schedule: "0 */2 * * *",
};

export default async () => {
  try {
    await sendCostReport();
    console.log("Cost report completed successfully.");
  } catch (error) {
    console.error("AWS Cost Monitoring Error:", error);
    throw error;
  }
};
