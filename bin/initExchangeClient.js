require("dotenv").config();
const ccxt = require('ccxt');

try {
    // Luno
    const luno = new ccxt.luno({
        apiKey: process.env.LUNO_KEY,
        secret: process.env.LUNO_SECRET
    })

    // FTX
    let ftxOptions = {
        apiKey: process.env.FTX_KEY,
        secret: process.env.FTX_SECRET,
        headers: {}
    }
    if (process.env.FTX_SUBACCOUNT_NAME_NOSPACE) {
        ftxOptions.headers['FTX-SUBACCOUNT'] = process.env.FTX_SUBACCOUNT_NAME_NOSPACE
    }
    const FTX = new ccxt.ftx(ftxOptions)

    // Binance
    const Binance = new ccxt.binance({
        apiKey: process.env.BINANCE_KEY,
        secret: process.env.BINANCE_SECRET
    })

    let exchangeObj = { luno }
    if (process.env.FTX_KEY) { console.log("-I- (Slave) FTX exchange detected."); exchangeObj['FTX'] = FTX }
    if (process.env.BINANCE_KEY) { console.log("-I- (Slave) Binance exchange detected."); exchangeObj['Binance'] = Binance }
    if (Object.keys(exchangeObj).length < 2) { console.log("-E- Please specify a slave exchange api key. E.g. FTX/Binance"); process.exit() }
    
    // TODO: Update supported exchange list
    module.exports = exchangeObj
} catch (error) {
    throw error
}
