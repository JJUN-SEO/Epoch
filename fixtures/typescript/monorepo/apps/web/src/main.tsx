import { add, format } from "@mono/core";
import { data } from "@mono/data";
import type { Route } from "./types";
import "./styles.css";
import React from "react";

export const home = () => import("./routes/home");
export const route = (name: string) => import(`./routes/${name}`);
export const App = (r: Route) => <div>{format(add(1, 2))}{String(data)}{r.path}{React.version}</div>;
