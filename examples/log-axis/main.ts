import { ChartGPU } from "../../src";

async function main() {
  const container = document.getElementById("chart-container");
  if (!container) return;

  const data: number[][] = [];
  for (let i = 0; i <= 100; i++) {
    // Generate exponential data: 10^1 to 10^5
    const value = Math.pow(10, 1 + (i / 100) * 4) + (Math.random() - 0.5) * Math.pow(10, 1 + (i / 100) * 3.5);
    data.push([i, value]);
  }

  const chart = await ChartGPU.create(container, {
    grid: { left: 80, right: 30, top: 24, bottom: 40 },
    xAxis: {
      type: "value",
      name: "Linear X (0 to 100)",
    },
    yAxis: {
      type: "log",
      name: "Logarithmic Y (10 to 100,000)",
    },
    series: [
      {
        type: "line",
        data,
        color: "#4f46e5",
        lineWidth: 2,
        area: {
          color: "rgba(79, 70, 229, 0.2)",
        },
      },
      {
        type: "scatter",
        data: data.filter((_, i) => i % 5 === 0), // subset of points
        color: "#f43f5e",
        symbolSize: 6,
      }
    ],
  });
}

main().catch(console.error);
