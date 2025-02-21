import axios from "axios";
import { errorSnapshot } from "./error";
import { Span } from "@opentelemetry/api";
import { SgFilter } from "./types";

export type SgOrder = {
    id: string;
    owner: string;
    orderHash: string;
    orderBytes: string;
    active: boolean;
    nonce: string;
    orderbook: {
        id: string;
    };
    inputs: {
        balance: string;
        vaultId: string;
        token: {
            address: string;
            decimals: string | number;
            symbol: string;
        };
    }[];
    outputs: {
        balance: string;
        vaultId: string;
        token: {
            address: string;
            decimals: string | number;
            symbol: string;
        };
    }[];
};

export type NewSgOrder = {
    order: SgOrder;
    timestamp: number;
};

export type SgTx = {
    events: SgEvent[];
    timestamp: string;
};

export type SgEvent = SgAddRemoveEvent | SgOtherEvent;

export type SgAddRemoveEvent = {
    __typename: "AddOrder" | "RemoveOrder";
    order: SgOrder;
};

export type SgOtherEvent = {
    __typename: "Withdrawal" | "Deposit";
};

/**
 * Method to get the subgraph query body with optional filters
 * @param skip - Number of results to skip
 * @param filters - Applies the filters for query
 * @returns the query string
 */
export function getQueryPaginated(skip: number, filters?: SgFilter): string {
    const getFilterVar = (header: string, f?: string[]) =>
        f ? `${header}: [${f.map((v) => `"${v.toLowerCase()}"`).join(", ")}], ` : "";

    const incOwnerFilter = getFilterVar("owner_in", filters?.includeOwners);
    const exOwnerFilter = getFilterVar("owner_not_in", filters?.excludeOwners);
    const incOrderFilter = getFilterVar("orderHash_in", filters?.includeOrders);
    const exOrderFilter = getFilterVar("orderHash_not_in", filters?.excludeOrders);
    const incOrderbookFilter = getFilterVar("orderbook_in", filters?.includeOrderbooks);
    const exOrderbookFilter = getFilterVar("orderbook_not_in", filters?.excludeOrderbooks);

    return `{
    orders(
        first: 100,
        skip: ${skip},
        orderBy: timestampAdded,
        orderDirection: desc,
        where: {
            ${incOwnerFilter}
            ${exOwnerFilter}
            ${incOrderFilter}
            ${exOrderFilter}
            ${incOrderbookFilter}
            ${exOrderbookFilter}
            active: true
        }
    ) {
        id
        owner
        orderHash
        orderBytes
        active
        nonce
        orderbook {
            id
        }
        inputs {
            balance
            vaultId
            token {
                address
                decimals
                symbol
            }
        }
        outputs {
            balance
            vaultId
            token {
                address
                decimals
                symbol
            }
        }
    }
}`;
}

/**
 * Get all active orders from a subgraph, with optional filters
 * @param subgraph - Subgraph url
 * @param orderHash - orderHash filter
 * @param owner - owner filter
 * @param orderbook - orderbook filter
 * @param timeout - timeout
 */
export async function querySgOrders(
    subgraph: string,
    filters?: SgFilter,
    timeout?: number,
): Promise<SgOrder[]> {
    const result: any[] = [];
    let skip = 0;
    for (;;) {
        const res = await axios.post(
            subgraph,
            {
                query: getQueryPaginated(skip, filters),
            },
            { headers: { "Content-Type": "application/json" }, timeout },
        );
        if (res?.data?.data?.orders?.length) {
            const orders = res.data.data.orders;
            result.push(...orders);
            if (orders.length < 100) {
                break;
            } else {
                skip += 100;
            }
        } else {
            break;
        }
    }
    return result;
}

export const orderbooksQuery = `{
    orderbooks {
        id
    }
}`;

export const statusCheckQuery = `{
    _meta {
        hasIndexingErrors
        block {
            number
        }
    }
}`;

/**
 * Get query for transactions
 */
export const getTxsQuery = (start: number, skip: number) => {
    return `{transactions(
    orderBy: timestamp
    orderDirection: asc
    first: 100
    skip: ${skip}
    where: { timestamp_gt: "${start}" }
  ) {
    events {
        __typename
        ... on AddOrder {
            transaction {
                timestamp
            }
            order {
                id
                owner
                orderHash
                orderBytes
                active
                nonce
                orderbook {
                    id
                }
                inputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
                outputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
            }
        }
        ... on RemoveOrder {
            transaction {
                timestamp
            }
            order {
                id
                owner
                orderHash
                orderBytes
                active
                nonce
                orderbook {
                    id
                }
                inputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
                outputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
            }
        }
    }
    timestamp
}}`;
};

/**
 * Fecthes the order changes after the given time and skipping the first skip txs
 * @param subgraph - The subgraph url
 * @param startTimestamp - start timestamp range
 * @param skip - skip count
 * @param timeout - promise timeout
 */
export async function getOrderChanges(
    subgraph: string,
    startTimestamp: number,
    skip: number,
    span?: Span,
    filters?: SgFilter,
) {
    let skip_ = skip;
    let count = 0;
    const allResults: SgTx[] = [];
    const addOrders: NewSgOrder[] = [];
    const removeOrders: NewSgOrder[] = [];
    for (;;) {
        try {
            const res = await axios.post(
                subgraph,
                { query: getTxsQuery(startTimestamp, skip_) },
                { headers: { "Content-Type": "application/json" } },
            );
            if (typeof res?.data?.data?.transactions !== "undefined") {
                const txs = res.data.data.transactions;
                count += txs.length;
                allResults.push(...txs);
                if (txs.length < 100) {
                    break;
                } else {
                    skip_ += 100;
                }
            } else {
                break;
            }
        } catch (error) {
            span?.addEvent(errorSnapshot(`Failed to get orders changes ${subgraph}`, error));
            throw error;
        }
    }
    allResults.forEach((tx) => {
        if (tx?.events?.length) {
            tx.events.forEach((event) => {
                if (event.__typename === "AddOrder") {
                    if (typeof event?.order?.active === "boolean" && event.order.active) {
                        if (!addOrders.find((e) => e.order.id === event.order.id)) {
                            const newOrder = {
                                order: event.order as SgOrder,
                                timestamp: Number(tx.timestamp),
                            };
                            if (applyFilters(newOrder, filters)) {
                                addOrders.push(newOrder);
                            }
                        }
                    }
                }
                if (event.__typename === "RemoveOrder") {
                    if (typeof event?.order?.active === "boolean" && !event.order.active) {
                        if (!removeOrders.find((e) => e.order.id === event.order.id)) {
                            removeOrders.push({
                                order: event.order as SgOrder,
                                timestamp: Number(tx.timestamp),
                            });
                        }
                    }
                }
            });
        }
    });
    return { addOrders, removeOrders, count };
}

/**
 * Applies the filters to the given new added order queried from subgraph tx events
 * @param order - The new added order
 * @param filters - The subgraph filters
 */
export function applyFilters(order: NewSgOrder, filters?: SgFilter): boolean {
    if (!filters) return true;
    else {
        // apply include filter
        if (filters.includeOrderbooks) {
            if (!filters.includeOrderbooks.includes(order.order.orderbook.id)) {
                return false;
            }
        }
        if (filters.includeOrders) {
            if (!filters.includeOrders.includes(order.order.orderHash)) {
                return false;
            }
        }
        if (filters.includeOwners) {
            if (!filters.includeOwners.includes(order.order.owner)) {
                return false;
            }
        }

        // apply exclude filters
        if (filters.excludeOrderbooks) {
            if (filters.excludeOrderbooks.includes(order.order.orderbook.id)) {
                return false;
            }
        }
        if (filters.excludeOrders) {
            if (filters.excludeOrders.includes(order.order.orderHash)) {
                return false;
            }
        }
        if (filters.excludeOwners) {
            if (filters.excludeOwners.includes(order.order.owner)) {
                return false;
            }
        }

        return true;
    }
}
