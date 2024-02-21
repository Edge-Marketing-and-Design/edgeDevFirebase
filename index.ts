import { EdgeFirebase } from "./edgeFirebase";
export default {
  install: (app, options, isPersistant, enablePopupRedirect) => {
    const eFb = new EdgeFirebase(options, isPersistant, enablePopupRedirect);
    app.provide("edgeFirebase", eFb);
  }
};
export { EdgeFirebase };
