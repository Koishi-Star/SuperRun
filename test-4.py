class Person:
    """一个简单的 Person 类示例"""
    
    def __init__(self, name, age):
        self.name = name
        self.age = age
    
    def greet(self):
        return f"Hello, my name is {self.name} and I am {self.age} years old."
    
    def have_birthday(self):
        self.age += 1
        return f"Happy birthday! {self.name} is now {self.age} years old."


# 使用示例
if __name__ == "__main__":
    person = Person("Alice", 25)
    print(person.greet())
    print(person.have_birthday())
