import { EdgeFirebase } from "./edgeFirebase";
export default {
  install: (app, options) => {
    const eFb = new EdgeFirebase(options);
    app.provide("edgeFirebase", eFb);
  }
};
export { EdgeFirebase };
