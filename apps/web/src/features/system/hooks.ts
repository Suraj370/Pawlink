import { useQuery } from "@tanstack/react-query";
import { apiHealthQueryOptions } from "./api";

export function useApiHealth() {
  return useQuery(apiHealthQueryOptions);
}
