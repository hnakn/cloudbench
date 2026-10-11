console.log("Starting CloudBench server...");
const express = require("express");

const {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} = require("@aws-sdk/client-cloudwatch");

const {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} = require("@aws-sdk/client-auto-scaling");

const fs = require("fs");
const { spawn } = require("child_process");

const awsRegion = "ap-south-1";

const cloudWatch = new CloudWatchClient({
  region: awsRegion,
});

const autoScaling = new AutoScalingClient({
  region: awsRegion,
});


const app = express();
app.use((req, res, next) => {
  const allowedOrigins = [
    "http://localhost:3002"
  ];

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});
const path = require("path");

app.use(express.static(path.join(__dirname, "public")));const PORT = process.env.PORT || 3000;




app.get("/api/work", (req, res) => {
    const iterations = parseInt(req.query.iterations) || 1000000;

    const start = Date.now();

    let result = 0;

    for (let i = 0; i < iterations; i++) {
        result += Math.sqrt(i) * Math.sin(i);
    }

    const durationMs = Date.now() - start;

    res.json({
        message: "Work completed",
        iterations: iterations,
        durationMs: durationMs
    });
});



app.get("/api/metrics/aws", async (req, res) => {
  try {
    const scalingResult = await autoScaling.send(
      new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: ["cloudbench-asg"],
      })
    );

    const group = scalingResult.AutoScalingGroups?.[0];

    const instances = (group?.Instances ?? [])
      .filter(instance =>
        instance.LifecycleState === "InService" &&
        instance.HealthStatus === "Healthy"
      );

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);

    const cpuValues = await Promise.all(
      instances.map(async instance => {
        const result = await cloudWatch.send(
          new GetMetricStatisticsCommand({
            Namespace: "AWS/EC2",
            MetricName: "CPUUtilization",
            Dimensions: [
              { Name: "InstanceId", Value: instance.InstanceId },
            ],
            StartTime: startTime,
            EndTime: endTime,
            Period: 300,
            Statistics: ["Average"],
          })
        );

        const datapoints = (result.Datapoints ?? [])
          .filter(point => point.Average != null && point.Timestamp)
          .sort(
            (a, b) =>
              new Date(b.Timestamp).getTime() -
              new Date(a.Timestamp).getTime()
          );

        return {
          instanceId: instance.InstanceId,
          cpuUtilizationPercent: datapoints[0]?.Average ?? null,
          cpuMetricTimestamp: datapoints[0]?.Timestamp ?? null,
        };
      })
    );

    const availableCpu = cpuValues.filter(
      item => item.cpuUtilizationPercent != null
    );

    const averageCpu = availableCpu.length
      ? availableCpu.reduce(
          (sum, item) => sum + item.cpuUtilizationPercent, 0
        ) / availableCpu.length
      : null;

    const latestTimestamp = availableCpu
      .map(item => item.cpuMetricTimestamp)
      .filter(Boolean)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
      ?? null;

    res.json({
      provider: "aws",
      region: awsRegion,
      timestamp: new Date().toISOString(),
      cpuUtilizationPercent: averageCpu,
      cpuMetricTimestamp: latestTimestamp,
      instanceCount: instances.length,
      desiredCapacity: group?.DesiredCapacity ?? null,
      minSize: group?.MinSize ?? null,
      maxSize: group?.MaxSize ?? null,
      instances: cpuValues,
    });
  } catch (error) {
    console.error("AWS metrics error:", error);
    res.status(500).json({
      error: "Unable to retrieve AWS metrics",
      details: error.message,
    });
  }
});


let k6Process = null;

app.post("/api/k6/start", (req, res) => {
  if (k6Process) {
    return res.status(409).json({ error: "A k6 test is already running" });
  }

  const outputFile = path.join(__dirname, "k6-live.json");
  const scriptFile = path.join(__dirname, "loadtest.js");

  try {
    if (fs.existsSync(outputFile)) {
      fs.unlinkSync(outputFile);
    }

    k6Process = spawn(
      "k6",
      ["run", "--out", "json=k6-live.json", "loadtest.js"],
      { cwd: __dirname, shell: true }
    );

    k6Process.on("error", (err) => {
      console.error("Could not start k6:", err.message);
      k6Process = null;
    });

    k6Process.on("close", (code) => {
      console.log("k6 finished with exit code:", code);
      k6Process = null;
    });

    res.json({ message: "k6 test started" });
  } catch (err) {
    k6Process = null;
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/k6/live", (req, res) => {
  const outputFile = path.join(__dirname, "k6-live.json");

  if (!fs.existsSync(outputFile)) {
    return res.json({
      running: Boolean(k6Process),
      rps: 0,
      p95Ms: null,
      failureRate: 0,
      vus: 0,
      requests: 0
    });
  }

  try {
    const lines = fs.readFileSync(outputFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);

    const points = [];

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.type === "Point") points.push(item);
      } catch {}
    }

    const now = Date.now();
    const recent = points.filter(p =>
      now - new Date(p.data.time).getTime() <= 10000
    );

    const values = (name, source = recent) =>
      source.filter(p => p.metric === name);

    const durations = values("http_req_duration")
      .map(p => p.data.value)
      .sort((a, b) => a - b);

    const requests = values("http_reqs");
    const failures = values("http_req_failed");
    const vusPoints = values("vus", points);

    res.json({
      running: Boolean(k6Process),
      rps: requests.length / 10,
      p95Ms: durations.length
        ? durations[Math.ceil(durations.length * 0.95) - 1]
        : null,
      failureRate: failures.length
        ? failures.reduce((sum, p) => sum + p.data.value, 0) / failures.length
        : 0,
      vus: vusPoints.length
        ? vusPoints[vusPoints.length - 1].data.value
        : 0,
      requests: values("http_reqs", points).length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/k6/stop", (req, res) => {
  if (!k6Process) {
    return res.json({ message: "No k6 test is running" });
  }

  k6Process.kill();
  res.json({ message: "Stop requested" });
});



app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});