const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("alphaNineSuite", {
  desktop: true
});
