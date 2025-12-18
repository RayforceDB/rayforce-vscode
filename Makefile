.PHONY: package install-code install-cursor clean

VERSION := $(shell node -p "require('./package.json').version")
VSIX_FILE := rayforce-vscode-$(VERSION).vsix

package:
	@npm run compile
	@vsce package

install-code: package
	@code --install-extension $(VSIX_FILE)

install-cursor: package
	@cursor --install-extension $(VSIX_FILE)

clean:
	@rm -f *.vsix
	@rm -rf out/
