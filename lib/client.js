"use strict";
/**
 * @file DPay RPC client implementation.
 * @author Johan Nordberg <code@johan-nordberg.com>
 * @license
 * Copyright (c) 2017 Johan Nordberg. All Rights Reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 *  1. Redistribution of source code must retain the above copyright notice, this
 *     list of conditions and the following disclaimer.
 *
 *  2. Redistribution in binary form must reproduce the above copyright notice,
 *     this list of conditions and the following disclaimer in the documentation
 *     and/or other materials provided with the distribution.
 *
 *  3. Neither the name of the copyright holder nor the names of its contributors
 *     may be used to endorse or promote products derived from this software without
 *     specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 * IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 * INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
 * BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
 * OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED
 * OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * You acknowledge that this software is not designed, licensed or intended for use
 * in the design, construction, operation or maintenance of any military facility.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const verror_1 = require("verror");
const version_1 = require("./version");
const blockchain_1 = require("./helpers/blockchain");
const broadcast_1 = require("./helpers/broadcast");
const database_1 = require("./helpers/database");
const utils_1 = require("./utils");
/**
 * Library version.
 */
exports.VERSION = version_1.default;
/**
 * Main dpay network chain id.
 */
exports.DEFAULT_CHAIN_ID = Buffer.from('38f14b346eb697ba04ae0f5adcfaa0a437ed3711197704aa256a14cb9b4a8f26', 'hex');
/**
 * Main dpay network address prefix.
 */
exports.DEFAULT_ADDRESS_PREFIX = 'DWB';
/**
 * RPC Client
 * ----------
 * Can be used in both node.js and the browser. Also see {@link ClientOptions}.
 */
class Client {
    /**
     * @param address The address to the DPay RPC server, e.g. `https://api.dpays.io`.
     * @param options Client options.
     */
    constructor(address, options = {}) {
        this.seqNo = 0;
        this.address = address;
        this.options = options;
        this.chainId = options.chainId ? Buffer.from(options.chainId, 'hex') : exports.DEFAULT_CHAIN_ID;
        assert.equal(this.chainId.length, 32, 'invalid chain id');
        this.addressPrefix = options.addressPrefix || exports.DEFAULT_ADDRESS_PREFIX;
        this.timeout = options.timeout || 60 * 1000;
        this.backoff = options.backoff || defaultBackoff;
        this.database = new database_1.DatabaseAPI(this);
        this.broadcast = new broadcast_1.BroadcastAPI(this);
        this.blockchain = new blockchain_1.Blockchain(this);
    }
    /**
     * Create a new client instance configured for the testnet.
     */
    static testnet(options) {
        let opts = {};
        if (options) {
            opts = utils_1.copy(options);
            opts.agent = options.agent;
        }
        opts.addressPrefix = 'DWB';
        opts.chainId = '38f14b346eb697ba04ae0f5adcfaa0a437ed3711197704aa256a14cb9b4a8f26';
        return new Client('https://dpayd.dpays.io', opts);
    }
    /**
     * Make a RPC call to the server.
     *
     * @param api     The API to call, e.g. `database_api`.
     * @param method  The API method, e.g. `get_dynamic_global_properties`.
     * @param params  Array of parameters to pass to the method, optional.
     *
     */
    call(api, method, params = []) {
        return __awaiter(this, void 0, void 0, function* () {
            const request = {
                id: ++this.seqNo,
                jsonrpc: '2.0',
                method: 'call',
                params: [api, method, params],
            };
            const body = JSON.stringify(request, (key, value) => {
                // encode Buffers as hex strings instead of an array of bytes
                if (typeof value === 'object' && value.type === 'Buffer') {
                    return Buffer.from(value.data).toString('hex');
                }
                return value;
            });
            const opts = {
                body,
                cache: 'no-cache',
                headers: { 'User-Agent': `ddpayv1/${version_1.default}` },
                method: 'POST',
                mode: 'cors',
            };
            if (this.options.agent) {
                opts.agent = this.options.agent;
            }
            let fetchTimeout;
            if (api !== 'network_broadcast_api') {
                // bit of a hack to work around some nodes high error rates
                // only effective in node.js (until timeout spec lands in browsers)
                fetchTimeout = (tries) => (tries + 1) * 500;
            }
            const response = yield utils_1.retryingFetch(this.address, opts, this.timeout, this.backoff, fetchTimeout);
            if (response.error) {
                const { data } = response.error;
                let { message } = response.error;
                if (data && data.stack && data.stack.length > 0) {
                    const top = data.stack[0];
                    const topData = utils_1.copy(top.data);
                    message = top.format.replace(/\$\{([a-z_]+)\}/gi, (match, key) => {
                        let rv = match;
                        if (topData[key]) {
                            rv = topData[key];
                            delete topData[key];
                        }
                        return rv;
                    });
                    const unformattedData = Object.keys(topData)
                        .map((key) => ({ key, value: topData[key] }))
                        .filter((item) => typeof item.value === 'string')
                        .map((item) => `${item.key}=${item.value}`);
                    if (unformattedData.length > 0) {
                        message += ' ' + unformattedData.join(' ');
                    }
                }
                throw new verror_1.VError({ info: data, name: 'RPCError' }, message);
            }
            assert.equal(response.id, request.id, 'got invalid response id');
            return response.result;
        });
    }
}
exports.Client = Client;
/**
 * Default backoff function.
 * ```min(tries*10^2, 10 seconds)```
 */
const defaultBackoff = (tries) => {
    return Math.min(Math.pow(tries * 10, 2), 10 * 1000);
};
