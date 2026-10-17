import { useEffect, useState } from "react";
import type { Entity } from "../types";
import { api, items } from "../api";
export function patientPageQuery(
  replication: string,
  at: string,
  filters: Record<string, string | undefined>,
  page: number,
  size: number,
) {
  const params = new URLSearchParams({
    at,
    limit: String(size),
    cursor: String(page * size),
  });
  for (const [name, value] of Object.entries(filters))
    if (value !== undefined && value !== "") params.set(name, value);
  return `/runs/${encodeURIComponent(replication)}/patients?${params}`;
}
export function usePatientPage(
  replication: string | undefined,
  at: string,
  filters: Record<string, string | undefined>,
  size: number,
  fallback: Entity[] = [],
  datasetId?: string,
) {
  const key = JSON.stringify([replication, datasetId, at, filters]),
    [position, setPosition] = useState({ key: "", page: 0 }),
    [result, setResult] = useState<{
      url: string;
      rows: Entity[];
      total: number;
      next: boolean;
      error: string;
    } | null>(null);
  const page = position.key === key ? position.page : 0,
    url = replication
      ? patientPageQuery(replication, at, filters, page, size)
      : datasetId
        ? `/datasets/${encodeURIComponent(datasetId)}/patients?${new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined && value !== "") as [string, string][]), limit: String(size), cursor: String(page * size) })}`
        : null;
  const setPage = (value: number | ((page: number) => number)) =>
    setPosition({
      key,
      page: Math.max(0, typeof value === "function" ? value(page) : value),
    });
  useEffect(() => {
    if (!url) return;
    let ignore = false;
    const timer = setTimeout(() => {
      api(url)
        .then((value) => {
          if (!ignore)
            setResult({
              url,
              rows: items(value),
              total: Number(value.total ?? items(value).length),
              next: !!value.next_cursor,
              error: "",
            });
        })
        .catch((error) => {
          if (!ignore)
            setResult({
              url,
              rows: [],
              total: 0,
              next: false,
              error: error.message,
            });
        });
    }, 80);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [url]);
  const current = url && result?.url === url ? result : null;
  return {
    page,
    setPage,
    rows: url
      ? current?.rows || []
      : fallback.slice(page * size, page * size + size),
    total: url ? (current?.total ?? 0) : fallback.length,
    loading: !!url && !current,
    error: current?.error || "",
    hasNext: url ? current?.next || false : (page + 1) * size < fallback.length,
  };
}
