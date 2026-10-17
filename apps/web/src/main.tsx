import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { hospitalTheme } from "./theme";
import App from "./App";
import "./styles.css";
import "./hospital.css";
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30000, retry: 1 } },
});
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={hospitalTheme} forceColorScheme="light">
        <App />
      </MantineProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
