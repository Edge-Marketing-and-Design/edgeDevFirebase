import { EdgeFirebase } from "./edgeFirebase";
export default {
  install: (app, options, isPersistant, enablePopupRedirect) => {
    const eFb = new EdgeFirebase(options, isPersistant, enablePopupRedirect);
    eFb.installErrorReporting(app);
    app.provide("edgeFirebase", eFb);
  }
};
export { EdgeFirebase };
export type { EdgeErrorReportingOptions } from "./errorReporting";
