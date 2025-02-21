const { assert } = require("chai");
const { AxiosError } = require("axios");
const { checkSgStatus, handleSgResults, getSgOrderbooks } = require("../src/sg");
const { applyFilters } = require("../src/query");

describe("Test read subgraph", async function () {
    it("should check subgraph status", async function () {
        const sgsUrls = ["url1", "url2"];
        const error1 = new Error("some error");
        const error2 = new Error("some other error");
        const code1 = "some code";
        const code2 = "some other code";
        const axiosError1 = AxiosError.from(error1, code1);
        const axiosError2 = AxiosError.from(error2, code2);

        const mockSgStatusOk = [
            {
                status: "fulfilled",
                reason: undefined,
                value: {
                    data: {
                        data: {
                            _meta: {
                                hasIndexingErrors: false,
                                block: { number: 123 },
                            },
                        },
                    },
                },
            },
            {
                status: "fulfilled",
                reason: undefined,
                value: {
                    data: {
                        data: {
                            _meta: {
                                hasIndexingErrors: false,
                                block: { number: 122 },
                            },
                        },
                    },
                },
            },
        ];
        let result;
        try {
            result = checkSgStatus(sgsUrls, mockSgStatusOk);
        } catch {
            throw "expected to resolve, but rejected";
        }
        assert.deepEqual(result.availableSgs, sgsUrls);
        assert.deepEqual(result.reasons, {});

        const mockSgStatusRejected = [
            {
                status: "rejected",
                reason: axiosError1,
                value: undefined,
            },
            {
                status: "rejected",
                reason: axiosError2,
                value: undefined,
            },
        ];
        try {
            checkSgStatus(sgsUrls, mockSgStatusRejected);
            throw "expected to reject, but resolved";
        } catch (error) {
            const errorMsg = [
                "subgraphs status check failed",
                `${sgsUrls[0]}:`,
                `Reason: ${error1.message}`,
                `Code: ${code1}`,
                `${sgsUrls[1]}:`,
                `Reason: ${error2.message}`,
                `Code: ${code2}`,
            ];
            assert.equal(error, errorMsg.join("\n"));
        }

        const mockSgStatusUndefined = [
            {
                status: "fulfilled",
                reason: undefined,
                value: undefined,
            },
            {
                status: "fulfilled",
                reason: undefined,
                value: undefined,
            },
        ];
        try {
            checkSgStatus(sgsUrls, mockSgStatusUndefined);
            throw "expected to reject, but resolved";
        } catch (error) {
            const errorMsg = [
                "subgraphs status check failed",
                `${sgsUrls[0]}:`,
                "Reason: did not receive valid status response",
                `${sgsUrls[1]}:`,
                "Reason: did not receive valid status response",
            ];
            assert.equal(error, errorMsg.join("\n"));
        }

        const mockSgStatusUndefinedPartial = [
            {
                status: "fulfilled",
                reason: undefined,
                value: {
                    data: {
                        data: {
                            _meta: {
                                hasIndexingErrors: false,
                                block: { number: 123 },
                            },
                        },
                    },
                },
            },
            {
                status: "fulfilled",
                reason: undefined,
                value: undefined,
            },
        ];
        try {
            result = checkSgStatus(sgsUrls, mockSgStatusUndefinedPartial);
        } catch (error) {
            throw "expected to resolve, but rejected";
        }
        assert.deepEqual(result.reasons, { url2: "did not receive valid status response" });
        assert.deepEqual(result.availableSgs, ["url1"]);

        const mockSgStatusIndexingError = [
            {
                status: "fulfilled",
                reason: undefined,
                value: {
                    data: {
                        data: {
                            _meta: {
                                hasIndexingErrors: true,
                                block: { number: 123 },
                            },
                        },
                    },
                },
            },
            {
                status: "fulfilled",
                reason: undefined,
                value: {
                    data: {
                        data: {
                            _meta: {
                                hasIndexingErrors: false,
                                block: { number: 123 },
                            },
                        },
                    },
                },
            },
        ];
        try {
            result = checkSgStatus(sgsUrls, mockSgStatusIndexingError);
        } catch (error) {
            throw "expected to resolve, but rejected";
        }
        assert.deepEqual(result.reasons, { url1: "subgraph has indexing error" });
        assert.deepEqual(result.availableSgs, ["url2"]);
    });

    it("should return correct orders details", async function () {
        const sgsUrls = ["url1", "url2"];
        const mockSgResultOk = [
            {
                status: "fulfilled",
                reason: undefined,
                value: ["order1", "order2"],
            },
            {
                status: "fulfilled",
                reason: undefined,
                value: ["order3", "order4"],
            },
        ];
        let result;
        try {
            result = handleSgResults(sgsUrls, mockSgResultOk);
        } catch {
            throw "expected to resolve, but rejected";
        }
        assert.deepEqual(result, ["order1", "order2", "order3", "order4"]);

        const mockSgResultRejected = [
            {
                status: "rejected",
                reason: undefined,
                value: ["order1", "order2"],
            },
            {
                status: "rejected",
                reason: undefined,
                value: ["order3", "order4"],
            },
        ];
        try {
            handleSgResults(sgsUrls, mockSgResultRejected);
            throw "expected to reject, but resolved";
        } catch (error) {
            assert.equal(error, "could not get order details from given sgs");
        }

        const mockSgResultPartial = [
            {
                status: "fulfilled",
                reason: undefined,
                value: ["order1", "order2"],
            },
            {
                status: "rejected",
                reason: undefined,
                value: undefined,
            },
        ];
        try {
            result = handleSgResults(sgsUrls, mockSgResultPartial);
        } catch {
            throw "expected to resolve, but rejected";
        }
        assert.deepEqual(result, ["order1", "order2"]);
    });

    it("should get subgraph orderbooks", async function () {
        const mockServer = require("mockttp").getLocal();
        await mockServer.start(8090);
        const orderbook1 = `0x${"1".repeat(40)}`;
        const orderbook2 = `0x${"2".repeat(40)}`;
        const sgResponse = {
            data: {
                orderbooks: [{ id: orderbook1 }, { id: orderbook2 }],
            },
        };
        await mockServer.forPost("/sg").thenJson(200, sgResponse);
        const result = await getSgOrderbooks(mockServer.url + "/sg");
        const expected = [orderbook1, orderbook2];
        assert.deepEqual(result, expected);
        await mockServer.stop();
    });

    it("should test applying sg filters to new orders", async function () {
        const filters = {
            includeOrders: [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`],
            excludeOrders: [`0x${"3".repeat(64)}`, `0x${"4".repeat(64)}`],
            includeOwners: [`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`],
            excludeOwners: [`0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`],
            includeOrderbooks: [`0x${"5".repeat(40)}`, `0x${"6".repeat(40)}`],
            excludeOrderbooks: [`0x${"7".repeat(40)}`, `0x${"8".repeat(40)}`],
        };
        const newOrder = {
            order: {
                orderHash: `0x${"1".repeat(64)}`,
                owner: `0x${"1".repeat(40)}`,
                orderbook: {
                    id: `0x${"7".repeat(40)}`,
                },
            },
        };
        assert(!applyFilters(newOrder, filters));

        newOrder.order = {
            orderHash: `0x${"1".repeat(64)}`,
            owner: `0x${"3".repeat(40)}`,
            orderbook: {
                id: `0x${"6".repeat(40)}`,
            },
        };
        assert(!applyFilters(newOrder, filters));

        newOrder.order = {
            orderHash: `0x${"3".repeat(64)}`,
            owner: `0x${"2".repeat(40)}`,
            orderbook: {
                id: `0x${"5".repeat(40)}`,
            },
        };
        assert(!applyFilters(newOrder, filters));

        newOrder.order = {
            orderHash: `0x${"1".repeat(64)}`,
            owner: `0x${"2".repeat(40)}`,
            orderbook: {
                id: `0x${"5".repeat(40)}`,
            },
        };
        assert(applyFilters(newOrder, filters));

        newOrder.order = {
            orderHash: `0x${"7".repeat(64)}`,
            owner: `0x${"7".repeat(40)}`,
            orderbook: {
                id: `0x${"2".repeat(40)}`,
            },
        };
        assert(!applyFilters(newOrder, filters));
    });
});
