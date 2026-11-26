// The edge suite's Worker entry: the real edge, with the WorkOS stand-in
// installed and the echoing stand-in bound as the space Durable Object.
import worker from "../../src/worker";
import { installFakeWorkos } from "./fake-workos";

installFakeWorkos();

export { EchoSpace as SpaceDO } from "./echo-space";
export default worker;
