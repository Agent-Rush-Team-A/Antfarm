{
  "modes": [
    {
      "mode": "single-vm",
      "revision": 3,
      "operationState": "ready"
    },
    {
      "mode": "single-docker",
      "revision": 6,
      "operationState": "ready"
    },
    {
      "mode": "multi-docker",
      "revision": 9,
      "operationState": "ready"
    },
    {
      "mode": "multi-vm",
      "revision": 12,
      "operationState": "ready"
    },
    {
      "mode": "single-vm",
      "revision": 15,
      "operationState": "ready"
    }
  ],
  "singleOrdinaryLogs": 1,
  "singleLocked": true,
  "forbidden": [
    "workspace/mode-locked",
    "workspace/session-operation-forbidden",
    "workspace/session-operation-forbidden"
  ],
  "foreignRead": "remote-access/denied",
  "multiOrdinarySessions": 3,
  "switchBeforeCreate": "single-docker",
  "createBeforeSwitch": "workspace/mode-locked",
  "earlyMessage": "workspace/mode-recovery-required",
  "loaderPendingRecovery": "ready"
}
