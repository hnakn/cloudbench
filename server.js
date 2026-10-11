const express = require("express");
const path = require("path");
const { spawn } = require("child_process");

// ============================================================
// AWS
// ============================================================

const {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} = require("@aws-sdk/client-cloudwatch");

const {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} = require("@aws-sdk/client-auto-scaling");

// ============================================================
// Azure
// ============================================================

const { DefaultAzureCredential } = require("@azure/identity");

const {
  ComputeManagementClient,
} = require("@azure/arm-compute");

// ============================================================
// APP SETUP
// ============================================================

const app = express();

const PORT =
  process.env.PORT || 3000;

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

console.log(
  "Starting CloudBench server..."
);

// ============================================================
// AWS CONFIGURATION
// ============================================================

const awsRegion =
  process.env.AWS_REGION ||
  "ap-south-1";

const awsAlbDns =
  process.env.AWS_ALB_DNS ||
  "cloudbench-alb-1180364049.ap-south-1.elb.amazonaws.com";

const awsAsgName =
  process.env.AWS_ASG_NAME ||
  "";

const cloudWatchClient =
  new CloudWatchClient({
    region: awsRegion,
  });

const autoScalingClient =
  new AutoScalingClient({
    region: awsRegion,
  });

// ============================================================
// AZURE CONFIGURATION
// ============================================================

const azureSubscriptionId =
  process.env.AZURE_SUBSCRIPTION_ID ||
  "b13461bf-e0ff-42db-a438-b5111ae9895e";

const azureResourceGroup =
  process.env.AZURE_RESOURCE_GROUP ||
  "cloud-scalability-rg-south";

const azureRegion =
  process.env.AZURE_REGION ||
  "southindia";

const azureVmssName =
  process.env.AZURE_VMSS_NAME ||
  "cloud-vmss-south";

const azureVmssResourceId =
  `/subscriptions/${azureSubscriptionId}` +
  `/resourceGroups/${azureResourceGroup}` +
  `/providers/Microsoft.Compute/virtualMachineScaleSets/${azureVmssName}`;

const azureCredential =
  new DefaultAzureCredential();

const azureComputeClient =
  new ComputeManagementClient(
    azureCredential,
    azureSubscriptionId
  );

// ============================================================
// BASIC ROUTE
// ============================================================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

// ============================================================
// WORK ENDPOINT
// ============================================================

app.get(
  "/api/work",
  (req, res) => {
    const iterations =
      Number(
        req.query.iterations
      ) || 1000000;

    const start =
      Date.now();

    let result = 0;

    for (
      let i = 0;
      i < iterations;
      i++
    ) {
      result += Math.sqrt(i);
    }

    const durationMs =
      Date.now() - start;

    res.json({
      message:
        "Work completed",

      iterations,

      durationMs,
    });
  }
);

// ============================================================
// AWS METRICS
// ============================================================

app.get(
  "/api/metrics/aws",
  async (req, res) => {
    try {
      const endTime =
        new Date();

      const startTime =
        new Date(
          endTime.getTime() -
            5 * 60 * 1000
        );

      let cpuUtilization =
        null;

      // ------------------------------------
      // AWS CPU
      // ------------------------------------

      try {
        if (awsAsgName) {
          const cpuCommand =
            new GetMetricStatisticsCommand({
              Namespace:
                "AWS/EC2",

              MetricName:
                "CPUUtilization",

              Dimensions: [
                {
                  Name:
                    "AutoScalingGroupName",

                  Value:
                    awsAsgName,
                },
              ],

              StartTime:
                startTime,

              EndTime:
                endTime,

              Period:
                300,

              Statistics: [
                "Average",
              ],
            });

          const cpuResponse =
            await cloudWatchClient.send(
              cpuCommand
            );

          if (
            cpuResponse.Datapoints &&
            cpuResponse.Datapoints.length >
              0
          ) {
            const sorted =
              cpuResponse.Datapoints.sort(
                (a, b) =>
                  new Date(
                    b.Timestamp
                  ) -
                  new Date(
                    a.Timestamp
                  )
              );

            cpuUtilization =
              sorted[0].Average;
          }
        }
      } catch (error) {
        console.error(
          "AWS CPU metric error:",
          error.message
        );
      }

      // ------------------------------------
      // AWS ASG
      // ------------------------------------

      let instanceCount =
        0;

      let desiredCapacity =
        0;

      let minSize =
        null;

      let maxSize =
        null;

      try {
        if (awsAsgName) {
          const asgCommand =
            new DescribeAutoScalingGroupsCommand({
              AutoScalingGroupNames: [
                awsAsgName,
              ],
            });

          const asgResponse =
            await autoScalingClient.send(
              asgCommand
            );

          const group =
            asgResponse
              .AutoScalingGroups?.[0];

          if (group) {
            instanceCount =
              group.Instances?.length ||
              0;

            desiredCapacity =
              group.DesiredCapacity ||
              0;

            minSize =
              group.MinSize ??
              null;

            maxSize =
              group.MaxSize ??
              null;
          }
        }
      } catch (error) {
        console.error(
          "AWS ASG error:",
          error.message
        );
      }

      res.json({
        provider:
          "aws",

        region:
          awsRegion,

        timestamp:
          new Date().toISOString(),

        cpuUtilizationPercent:
          cpuUtilization,

        cpuMetricTimestamp:
          new Date().toISOString(),

        instanceCount,

        desiredCapacity,

        minSize,

        maxSize,

        asgName:
          awsAsgName,
      });
    } catch (error) {
      console.error(
        "AWS metrics error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to retrieve AWS metrics",

        details:
          error.message,
      });
    }
  }
);

// ============================================================
// AZURE MONITOR CPU
// ============================================================

async function getAzureCpuMetric() {
  const endTime =
    new Date();

  const startTime =
    new Date(
      endTime.getTime() -
        15 * 60 * 1000
    );

  const tokenResponse =
    await azureCredential.getToken(
      "https://management.azure.com/.default"
    );

  if (
    !tokenResponse ||
    !tokenResponse.token
  ) {
    throw new Error(
      "Unable to obtain Azure management access token"
    );
  }

  const params =
    new URLSearchParams();

  params.set(
    "api-version",
    "2024-02-01"
  );

  params.set(
    "timespan",
    `${startTime.toISOString()}/${endTime.toISOString()}`
  );

  params.set(
    "interval",
    "PT5M"
  );

  params.set(
    "metricnames",
    "Percentage CPU"
  );

  params.set(
    "aggregation",
    "Average"
  );

  params.set(
    "metricnamespace",
    "Microsoft.Compute/virtualMachineScaleSets"
  );

  const url =
    `https://management.azure.com` +
    `${azureVmssResourceId}` +
    `/providers/microsoft.insights/metrics` +
    `?${params.toString()}`;

  const response =
    await fetch(
      url,
      {
        method:
          "GET",

        headers: {
          Authorization:
            `Bearer ${tokenResponse.token}`,

          Accept:
            "application/json",
        },
      }
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Azure Monitor HTTP ${response.status}: ${errorText}`
    );
  }

  const data =
    await response.json();

  let latestCpu =
    null;

  let latestCpuTimestamp =
    null;

  const metrics =
    data.value || [];

  for (
    const metric of metrics
  ) {
    const timeseries =
      metric.timeseries || [];

    for (
      const series of timeseries
    ) {
      const dataPoints =
        series.data || [];

      for (
        const point of dataPoints
      ) {
        if (
          point.average !==
            undefined &&
          point.average !==
            null
        ) {
          const timestamp =
            new Date(
              point.timeStamp
            );

          if (
            !latestCpuTimestamp ||
            timestamp >
              latestCpuTimestamp
          ) {
            latestCpu =
              point.average;

            latestCpuTimestamp =
              timestamp;
          }
        }
      }
    }
  }

  return {
    cpuUtilizationPercent:
      latestCpu,

    cpuMetricTimestamp:
      latestCpuTimestamp
        ? latestCpuTimestamp.toISOString()
        : null,
  };
}

// ============================================================
// AZURE METRICS
// ============================================================

app.get(
  "/api/metrics/azure",
  async (req, res) => {
    try {
      const instances = [];

      for await (
        const instance of
        azureComputeClient
          .virtualMachineScaleSetVMs
          .list(
            azureResourceGroup,
            azureVmssName
          )
      ) {
        instances.push({
          instanceId:
            instance.instanceId,

          vmName:
            instance.name,
        });
      }

      const vmss =
        await azureComputeClient
          .virtualMachineScaleSets
          .get(
            azureResourceGroup,
            azureVmssName
          );

      const capacity =
        vmss.sku?.capacity ??
        null;

      const cpu =
        await getAzureCpuMetric();

      res.json({
        provider:
          "azure",

        region:
          azureRegion,

        timestamp:
          new Date().toISOString(),

        cpuUtilizationPercent:
          cpu.cpuUtilizationPercent,

        cpuMetricTimestamp:
          cpu.cpuMetricTimestamp,

        instanceCount:
          instances.length,

        desiredCapacity:
          capacity,

        minSize:
          1,

        maxSize:
          1,

        instances:
          instances.map(
            (instance) => ({
              instanceId:
                instance.instanceId,

              vmName:
                instance.vmName,

              cpuUtilizationPercent:
                cpu.cpuUtilizationPercent,

              cpuMetricTimestamp:
                cpu.cpuMetricTimestamp,
            })
          ),
      });
    } catch (error) {
      console.error(
        "Azure metrics error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to retrieve Azure metrics",

        details:
          error.message,
      });
    }
  }
);

// ============================================================
// K6 STATE
// ============================================================

let k6Process =
  null;

let k6Status = {
  running:
    false,

  startedAt:
    null,

  target:
    null,

  output: [],
};

// ============================================================
// K6 OUTPUT PARSER
// ============================================================

function cleanK6Output(
  output
) {
  return output
    .join("")
    .replace(
      /\x1B\[[0-?]*[ -/]*[@-~]/g,
      ""
    );
}

function parseK6Metrics() {
  const text =
    cleanK6Output(
      k6Status.output
    );

  // ------------------------------------
  // Requests/sec and total requests
  //
  // Example:
  // http_reqs: 1267 3.516755/s
  // ------------------------------------

  let requests =
    null;

  let rps =
    null;

  const requestMatch =
    text.match(
      /http_reqs[.\s:]+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\/s/
    );

  if (requestMatch) {
    requests =
      Number(
        requestMatch[1]
      );

    rps =
      Number(
        requestMatch[2]
      );
  }

  // ------------------------------------
  // Response duration
  //
  // Example:
  // p(95)=3.58s
  // ------------------------------------

  let p95Ms =
    null;

  let avgMs =
    null;

  const durationMatch =
    text.match(
      /http_req_duration[.\s:]+avg=([0-9.]+)(ms|s).*?p\(95\)=([0-9.]+)(ms|s)/
    );

  if (durationMatch) {
    const avgValue =
      Number(
        durationMatch[1]
      );

    const avgUnit =
      durationMatch[2];

    const p95Value =
      Number(
        durationMatch[3]
      );

    const p95Unit =
      durationMatch[4];

    avgMs =
      avgUnit === "s"
        ? avgValue * 1000
        : avgValue;

    p95Ms =
      p95Unit === "s"
        ? p95Value * 1000
        : p95Value;
  }

  // ------------------------------------
  // Failure rate
  //
  // Example:
  // http_req_failed: 0.15% 2 out of 1267
  // ------------------------------------

  let failureRate =
    null;

  const failureMatch =
    text.match(
      /http_req_failed[.\s:]+([0-9.]+)%/
    );

  if (failureMatch) {
    failureRate =
      Number(
        failureMatch[1]
      ) / 100;
  }

  // ------------------------------------
  // VUs
  //
  // Final:
  // vus: 1 min=1 max=15
  //
  // Running:
  // 12/15 VUs
  // ------------------------------------

  let vus =
    null;

  let maxVus =
    null;

  const finalVusMatch =
    text.match(
      /vus[.\s:]+(\d+)\s+min=\d+\s+max=(\d+)/
    );

  if (finalVusMatch) {
    vus =
      Number(
        finalVusMatch[1]
      );

    maxVus =
      Number(
        finalVusMatch[2]
      );
  }

  const runningVusMatches =
    [
      ...text.matchAll(
        /(\d+)\/(\d+)\s+VUs/g
      ),
    ];

  if (
    runningVusMatches.length >
      0
  ) {
    const latest =
      runningVusMatches[
        runningVusMatches.length - 1
      ];

    vus =
      Number(
        latest[1]
      );

    maxVus =
      Number(
        latest[2]
      );
  }

  // ------------------------------------
  // If test is currently running,
  // parse completed iterations as a
  // temporary request count.
  // ------------------------------------

  if (
    requests === null
  ) {
    const runningMatches =
      [
        ...text.matchAll(
          /(\d+) complete and \d+ interrupted iterations/g
        ),
      ];

    if (
      runningMatches.length >
        0
    ) {
      const latest =
        runningMatches[
          runningMatches.length - 1
        ];

      requests =
        Number(
          latest[1]
        );
    }
  }

  // ------------------------------------
  // Estimate current RPS while running
  // from elapsed test time.
  // ------------------------------------

  if (
    rps === null &&
    requests !== null &&
    k6Status.startedAt
  ) {
    const elapsed =
      Date.now() -
      new Date(
        k6Status.startedAt
      ).getTime();

    if (
      elapsed >
      1000
    ) {
      rps =
        requests /
        (elapsed / 1000);
    }
  }

  return {
    rps,
    p95Ms,
    avgMs,
    failureRate,
    requests,
    vus,
    maxVus,
  };
}

// ============================================================
// START K6
// ============================================================

app.post(
  "/api/k6/start",
  async (req, res) => {
    try {
      if (k6Process) {
        return res
          .status(400)
          .json({
            error:
              "A k6 test is already running",
          });
      }

      const {
        target = "aws",
        script,
      } =
        req.body || {};

      const allowedTargets = [
        "aws",
        "azure",
      ];

      if (
        !allowedTargets.includes(
          target
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Target must be aws or azure",
          });
      }

      const k6Script =
        script ||
        path.join(
          __dirname,
          "loadtest.js"
        );

      k6Status = {
        running:
          true,

        startedAt:
          new Date().toISOString(),

        target,

        output: [],
      };

      k6Process =
        spawn(
          "k6",
          [
            "run",
            k6Script,
          ],
          {
            shell:
              false,

            env: {
              ...process.env,

              K6_TARGET:
                target,
            },
          }
        );

      k6Process.stdout.on(
        "data",
        (data) => {
          const text =
            data.toString();

          k6Status.output.push(
            text
          );

          console.log(
            "[k6]",
            text
          );
        }
      );

      k6Process.stderr.on(
        "data",
        (data) => {
          const text =
            data.toString();

          k6Status.output.push(
            text
          );

          console.error(
            "[k6]",
            text
          );
        }
      );

      k6Process.on(
        "error",
        (error) => {
          console.error(
            "k6 process error:",
            error
          );

          k6Status.output.push(
            `k6 process error: ${error.message}\n`
          );

          k6Status.running =
            false;

          k6Process =
            null;
        }
      );

      k6Process.on(
        "close",
        (code) => {
          console.log(
            `k6 finished with code ${code}`
          );

          k6Status.running =
            false;

          k6Process =
            null;
        }
      );

      res.json({
        message:
          "k6 test started",

        target,

        startedAt:
          k6Status.startedAt,
      });
    } catch (error) {
      console.error(
        "k6 start error:",
        error
      );

      k6Process =
        null;

      k6Status.running =
        false;

      res.status(500).json({
        error:
          "Unable to start k6",

        details:
          error.message,
      });
    }
  }
);

// ============================================================
// K6 LIVE
// ============================================================

app.get(
  "/api/k6/live",
  (req, res) => {
    const metrics =
      parseK6Metrics();

    res.json({
      running:
        k6Status.running,

      startedAt:
        k6Status.startedAt,

      target:
        k6Status.target,

      rps:
        metrics.rps,

      p95Ms:
        metrics.p95Ms,

      avgMs:
        metrics.avgMs,

      failureRate:
        metrics.failureRate,

      requests:
        metrics.requests,

      vus:
        metrics.vus,

      maxVus:
        metrics.maxVus,

      output:
        k6Status.output.slice(
          -50
        ),
    });
  }
);

// ============================================================
// STOP K6
// ============================================================

app.post(
  "/api/k6/stop",
  (req, res) => {
    try {
      if (!k6Process) {
        return res.json({
          message:
            "No k6 test is running",
        });
      }

      k6Process.kill();

      k6Process =
        null;

      k6Status.running =
        false;

      res.json({
        message:
          "k6 test stopped",
      });
    } catch (error) {
      console.error(
        "k6 stop error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to stop k6",

        details:
          error.message,
      });
    }
  }
);

// ============================================================
// SERVER
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);