import http from 'k6/http';
import { check, sleep } from 'k6';

const target = __ENV.K6_TARGET || 'aws';

const targets = {
  aws:
    'http://cloudbench-alb-1180364049.ap-south-1.elb.amazonaws.com/api/work?iterations=5000000',

  azure:
    'https://20.235.172.176/api/work?iterations=5000000',
};

const url = targets[target];

if (!url) {
  throw new Error(
    `Invalid K6_TARGET "${target}". Use "aws" or "azure".`
  );
}

export const options = {
  stages: [
    { duration: '1m', target: 5 },
    { duration: '2m', target: 10 },
    { duration: '2m', target: 15 },
    { duration: '1m', target: 0 },
  ],

  thresholds: {
    http_req_failed: ['rate<0.05'],
  },

  // Azure Application Gateway currently uses
  // a self-signed certificate.
  insecureSkipTLSVerify: target === 'azure',
};

export default function () {
  const res = http.get(url, {
    timeout: '60s',
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(1);
}