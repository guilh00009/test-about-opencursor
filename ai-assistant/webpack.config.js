//@ts-check
'use strict';

const path = require('path');

/**@type {import('webpack').Configuration}*/
const config = {
	target: 'node',
	entry: './src/extension.ts',
	output: {
		path: path.resolve(__dirname, 'out'),
		filename: 'extension.js',
		libraryTarget: 'commonjs2'
	},
	devtool: 'source-map',
	externals: {
		vscode: 'commonjs vscode'
	},
	resolve: {
		extensions: ['.ts', '.js']
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						loader: 'ts-loader',
						options: {
							compilerOptions: {
								module: 'commonjs'
							}
						}
					}
				]
			}
		]
	},
	performance: {
		hints: false
	}
};

module.exports = config;
