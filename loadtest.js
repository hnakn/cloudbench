
import http from 'k6/http';
import { check, sleep } from 'k6';

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
};

export default function () {
  const url =
    'http://cloudbench-alb-1180364049.ap-south-1.elb.amazonaws.com/api/work?iterations=5000000';

  const res = http.get(url, { timeout: '60s' });

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
