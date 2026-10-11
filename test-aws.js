
const {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} = require("@aws-sdk/client-cloudwatch");

async function main() {
  const client = new CloudWatchClient({
    region: "ap-south-1",
  });

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);

  const command = new GetMetricStatisticsCommand({
    Namespace: "AWS/EC2",
    MetricName: "CPUUtilization",
    Dimensions: [
      {
        Name: "InstanceId",
        Value: "i-088e1864c6b177feb",
      },
    ],
    StartTime: startTime,
    EndTime: endTime,
    Period: 300,
    Statistics: ["Average"],
  });

  try {
    const result = await client.send(command);
    console.log("CPU metric results:");
    console.log(JSON.stringify(result.Datapoints ?? [], null, 2));
  } catch (error) {
    console.error("AWS request failed:", error.name, error.message);
  }
}

main();
