.PHONY: help install package install-code install-cursor test clean ensure-vsce-installed version

# Variables
VERSION := $(shell node -p "require('./package.json').version")
VSIX_FILE := rayforce-vscode-$(VERSION).vsix

ensure-vsce-installed: ## Ensure vsce is installed globally
	@which vsce > /dev/null || (echo "Installing vsce..." && npm install -g @vscode/vsce)

package: ensure-vsce-installed
	@vsce package

install-code: clean package
	@code --install-extension $(VSIX_FILE)

install-cursor: clean package
	@cursor --install-extension $(VSIX_FILE)

clean:
	@rm -f *.vsix
