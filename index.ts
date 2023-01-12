import { EdgeFirebase } from "./edgeFirebase";
export default {
  install: (app, options, isPersistant) => {
    const eFb = new EdgeFirebase(options, isPersistant);
    app.provide("edgeFirebase", eFb);
  }
};
export { EdgeFirebase };
