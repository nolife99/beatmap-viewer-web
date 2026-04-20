import type Config from '.';

// deno-lint-ignore-file no-explicit-any
export default class ConfigSection {
	private _callbacks: Map<string, Set<(newValue: any) => void>> = new Map();

	constructor(private config: Config) {
	}

	onChange(key: string, callback: (newValue: any) => void) {
		if (!this._callbacks.get(key))
			this._callbacks.set(key, new Set());

		this._callbacks.get(key)?.add(callback);
	}

	emitChange(key: string, newValue: any) {
		this.config.saveSettings();

		const callbacks = this._callbacks.get(key);
		if (!callbacks) return Promise.resolve();
		return Promise.all(Iterator.from(callbacks).map(callback =>
			new Promise(resolve => setTimeout(() => {
				callback(newValue);
				resolve(undefined);
			}))));
	}

	jsonify() {
	}
}