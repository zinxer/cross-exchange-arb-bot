require("dotenv").config();
const BigNumber = require('bignumber.js')
const ccxtClient = require('./bin/initExchangeClient')
const { systemLog, updateBalanceFile } = require('./bin/term_log')
const { cancelLimitPlaceMarket, placeLimitOrder } = require('./controllers/core')
const { getExternalIpAddress, currTime, sleep, usdToMyr } = require('./bin/utils')
const axios = require('axios')
const si = require('systeminformation');
const util = require('util');
const { buda } = require("ccxt");

process.env.APP_ROOT = __dirname
process.env.BOT_VER = 'v2.4.1'

let TICKER = {}

let ASSETS = process.env.ASSETS.split(',');
const masterBase = 'MYR'
const slaveBase = 'USDT'

async function init() {
    try {
        if (process.env.SAFE_GAP_PERCENT < 0.5) {
            systemLog("error", `SAFE_GAP_PERCENT (${process.SAFE_GAP_PERCENT}) should not be less than 0.5.`)
            process.exit(0)
        }
        process.env.SI_DATA = JSON.stringify((await si.system()))
        const SI_DATA = JSON.parse(process.env.SI_DATA)
        let ipAddress = await getExternalIpAddress()
        process.env.IP_ADDRESS = ipAddress

        systemLog("info", `Initializing cross-exchange-arb-bot (${process.env.BOT_VER})...`)
        systemLog("system", `cross-exchange-arb-bot (${process.env.BOT_VER}) started`)

        initTicker()
        run()
    } catch (error) {
        throw error
    }
}

async function initTicker() {
    let _assets = [...ASSETS, masterBase, slaveBase]
    for (let asset of _assets) {
        TICKER[asset] = {}
        for (let exchange in ccxtClient) {
            let prop = { balance: undefined }
            if ((asset !== masterBase) && (asset !== slaveBase)) {
                prop['ask'] = undefined
                prop['bid'] = undefined
                prop['last'] = undefined

                if (exchange == 'luno') { prop['master'] = { buy: { bestPremiumPercent: undefined, slave: undefined }, sell: { bestPremiumPercent: undefined, slave: undefined } } }
            }

            TICKER[asset][exchange] = prop
        }
    }
}

async function fetchUsdtMyrRate() {
    try {
        let rate = process.env.USDTMYR || null
        if (!rate) {
            let queryData = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=myr`)
            process.env.USDTMYR = queryData.data['tether'].myr || 4.
            if (!queryData.data['tether'].myr) {
                systemLog("warning", `USDTMYR not set in .env and coingecko fetch usdtmyr rate failed. Default to 4.15`)
            }
        }

        return rate
    } catch (error) {
        throw error
    }

}

async function fetchTicker() {
    try {
        //console.time('fetchTicker')
        let promises = []

        for (let exClient in ccxtClient) {
            exClient = ccxtClient[exClient]
            let fetchTickerPromise = new Promise(async function (resolve, reject) {
                let base = slaveBase
                if (exClient.name == "luno") { base = masterBase }
                let symbols = []

                for (let asset of ASSETS) { symbols.push(`${asset}/${base}`) }
                let symbolData = await exClient.fetchTickers(symbols)

                for (let asset of ASSETS) {
                    let { bid, ask, last } = symbolData[`${asset}/${base}`]
                    TICKER[asset][exClient.name].bid = bid
                    TICKER[asset][exClient.name].ask = ask
                    TICKER[asset][exClient.name].last = last
                }
                resolve("OK")
            })
            promises.push(fetchTickerPromise)
        }

        await Promise.all(promises)
        //console.timeEnd('fetchTicker')
        process.env.TICKER = JSON.stringify(TICKER)
    } catch (error) {
        throw error
    }
}

async function fetchBalances() {
    try {
        for (let exClient in ccxtClient) {
            exClient = ccxtClient[exClient]
            let balances = await exClient.fetchBalance()
            for (let asset of ASSETS) {
                TICKER[asset][exClient.name]['balance'] = balances.free[asset] ? balances.free[asset] : 0
            }
            if (exClient.name == "luno") {
                TICKER[masterBase][exClient.name]['balance'] = balances.free[masterBase]
            } else {
                TICKER[slaveBase][exClient.name]['balance'] = balances.free[slaveBase]
            }
        }

        //await updateBalanceFile(TICKER)
    } catch (error) {
        throw error
    }
}

async function isBalSufficient(exchange, asset) {
    try {
        let orderSizeMyr = process.env.ORDER_SIZE_MYR

        if (asset == 'USDT' || asset == 'USD') {
            if (exchange == 'luno') { throw new Error("Luno does not have USDT balance.") }
            if (orderSizeMyr > usdToMyr(TICKER[asset][exchange].balance)) { return false } else { return true }
        }

        if (asset == 'MYR') {
            if (exchange !== 'luno') { throw new Error("Other exchanges does not have MYR balance.") }
            if (orderSizeMyr > TICKER[asset][exchange].balance) { return false } else { return true }
        }

        let balance = TICKER[asset][exchange].balance
        let balanceInLocalCurrency = (new BigNumber(TICKER[asset][exchange].last).multipliedBy(balance).toFixed(2))

        if (exchange !== 'luno') {
            balanceUsd = usdToMyr(balanceInLocalCurrency)
            if (orderSizeMyr > balanceUsd) { return false } else { return true }
        } else {
            if (orderSizeMyr > balanceInLocalCurrency) { return false } else { return true }
        }
    } catch (error) {
        throw error
    }
}

// compute all best price gap by asset and side
async function computeBestPremiumPercent() {
    try {
        for (let asset of ASSETS) {
            let lunoLast = TICKER[asset]['luno'].last

            for (let exchange in ccxtClient) {
                if (exchange == 'luno') { continue }
                else {
                    let slaveLastMyr = usdToMyr(TICKER[asset][exchange].last)
                    let minusBN = new BigNumber(lunoLast).minus(new BigNumber(slaveLastMyr))
                    let gapPercent = (((minusBN).dividedBy(new BigNumber(lunoLast))).multipliedBy(new BigNumber(100))).toFixed()

                    // to determine master sell bestPremiumPercent
                    // Check if there is sufficient asset balance on Luno and usdt balance on slave
                    if (!isBalSufficient('luno', asset) || !isBalSufficient(exchange, slaveBase)) { continue }
                    let bestPremiumPercentSell = TICKER[asset]['luno']['master']['sell'].bestPremiumPercent
                    if (bestPremiumPercentSell == undefined) {
                        TICKER[asset]['luno']['master']['sell'].bestPremiumPercent = gapPercent
                        TICKER[asset]['luno']['master']['sell'].slave = exchange
                    }
                    if (gapPercent > bestPremiumPercentSell) {
                        TICKER[asset]['luno']['master']['sell'].bestPremiumPercent = gapPercent
                        TICKER[asset]['luno']['master']['sell'].slave = exchange
                    }

                    gapPercent = new BigNumber(gapPercent).multipliedBy(-1).toFixed()
                    // to determine master buy bestPremiumPercent
                    // Check if there is sufficient asset balance on Luno and usdt balance on slave
                    if (!isBalSufficient('luno', masterBase) || !isBalSufficient(exchange, asset)) { continue }
                    let bestPremiumPercentBuy = TICKER[asset]['luno']['master']['buy'].bestPremiumPercent
                    if (bestPremiumPercentBuy == undefined) {
                        TICKER[asset]['luno']['master']['buy'].bestPremiumPercent = gapPercent
                        TICKER[asset]['luno']['master']['buy'].slave = exchange
                    }
                    if (gapPercent > bestPremiumPercentBuy) {
                        TICKER[asset]['luno']['master']['buy'].bestPremiumPercent = gapPercent
                        TICKER[asset]['luno']['master']['buy'].slave = exchange
                    }
                }
            }
        }
    } catch (error) {
        throw error
    }
}


async function run() {
    try {
        console.time('run')
        // set USDTMYR in .env to reduce time used to call coingecko api
        await fetchUsdtMyrRate()
        // populate TICKER glob
        await fetchTicker()
        // fetch new balance because it may be reduced from previous iter placements
        await fetchBalances()

        await computeBestPremiumPercent()

        //console.log(util.inspect(TICKER, { showHidden: false, depth: null, colors: true }))
        console.timeEnd('run')
        await run()
    } catch (error) {
        systemLog("error", String(error))
        await run();
    }
}


init()