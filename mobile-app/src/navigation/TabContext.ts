import React, { createContext, useContext } from "react";

export const TabContext = createContext<any>(null);

export const useTab = () => useContext(TabContext);