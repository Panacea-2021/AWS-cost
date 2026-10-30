
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

// Get today's date in India (YYYY-MM-DD)
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

// Subtract days from a YYYY-MM-DD date
function subtractDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function getAmount(value) {
  return Number(value || 0);
}

function formatCost(amount) {
  return `$${amount.toFixed(4)}`;
}

// Fetch AWS costs grouped by service
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

  const results = response.ResultsByTime || [];

  let total = 0;
  const services = {};

  for (const period of results) {
    for (const group of period.Groups || []) {
      const serviceName = group.Keys?.[0] || "Other";
      const amount = getAmount(
        group.Metrics?.UnblendedCost?.Amount
      );

      services[serviceName] =
        (services[serviceName] || 0) + amount;

      total += amount;
    }

    // Use AWS total if available
    if (period.Total?.UnblendedCost?.Amount !== undefined) {
      total = getAmount(period.Total.UnblendedCost.Amount);
    }
  }

  return { total, services };
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
      `Telegram failed for chat ${chatId}: ${JSON.stringify(result)}`
    );
  }

  console.log(`Telegram message sent successfully to ${chatId}`);
}

// Main report function
async function sendCostReport() {
  if (
    !process.env.COST_BOT_ACCESS_KEY_ID ||
    !process.env.COST_BOT_SECRET_ACCESS_KEY
  ) {
    throw new Error("AWS credentials are missing in Netlify environment variables.");
  }

  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing.");
  }

  if (CHAT_IDS.length === 0) {
    throw new Error("No Telegram chat IDs configured.");
  }

  // Cost Explorer End date is exclusive.
  // So fetch yesterday's complete daily cost.
  const today = getIndiaDate();
  const yesterday = subtractDays(today, 1);

  const monthStart = `${today.slice(0, 7)}-01`;

  console.log(`Fetching daily AWS cost for ${yesterday}`);
  console.log(`Fetching monthly AWS cost from ${monthStart} to ${today}`);

  // Daily cost: yesterday only
  const dailyData = await fetchCosts(
    yesterday,
    today,
    "DAILY"
  );

  // Monthly cost: first day of month up to yesterday
  let monthlyData = { total: 0, services: {} };

  if (monthStart < today) {
    monthlyData = await fetchCosts(
      monthStart,
      today,
      "MONTHLY"
    );
  }

  const dailyServiceLines = Object.entries(dailyData.services)
    .filter(([, amount]) => amount !== 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, amount]) => {
      return `• ${name}: ${formatCost(amount)}`;
    });

  const serviceText = dailyServiceLines.length
    ? dailyServiceLines.join("\n")
    : "No service costs reported for this date.";

  const message = `
<b>📊 AWS COST REPORT</b>

<b>📅 Daily Cost</b>
Date: ${yesterday}
<b>Total: ${formatCost(dailyData.total)}</b>

<b>📦 Daily Service Breakdown</b>
${serviceText}

<b>📆 Monthly Cost</b>
Period: ${monthStart} to ${yesterday}
<b>Monthly Total: ${formatCost(monthlyData.total)}</b>

<i>Source: AWS Cost Explorer</i>
<i>Note: AWS billing data may be delayed.</i>
`;

  // Send to personal chat and group independently
  const results = await Promise.allSettled(
    [...new Set(CHAT_IDS)].map((chatId) =>
      sendTelegramMessage(chatId, message)
    )
  );

  const failed = results.filter(
    (result) => result.status === "rejected"
  );

  if (failed.length > 0) {
    failed.forEach((result) => {
      console.error("Telegram notification error:", result.reason);
    });

    throw new Error(
      `${failed.length} Telegram notification(s) failed.`
    );
  }

  console.log("AWS cost report sent successfully.");

  return {
    dailyDate: yesterday,
    dailyTotal: dailyData.total,
    monthlyTotal: monthlyData.total,
    notificationsSent: results.length,
  };
}

// Netlify scheduled function: every 2 hours
export const config = {
  schedule: "0 */2 * * *",
};

export default async () => {
  try {
    const report = await sendCostReport();

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "AWS cost report sent successfully.",
        report,
      }),
    };
  } catch (error) {
    console.error("AWS Cost Monitoring Error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message,
      }),
    };
  }
};
