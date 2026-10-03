all: nodectl

nodectl: nodectl.c
	$(CC) $(CFLAGS) $(CPPFLAGS) -Wall -o $@ $< $(LDFLAGS) -luci

clean:
	rm -f nodectl
